import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_IDE, IDE_CHOICES, dashboardSelectionKey, defaultFeatureFlags, filterLogLines, isLogError,
    parseDashboardSelection, parseFeatureFlags,
    parsePreferredIDE, parsePreferences, portAddress, parseRecentWorkspaces, parseServicePresets,
    parseServiceNames, parseTerminalCommandPresets, projectDisplayName, projectMatches, rememberWorkspace,
    serviceDisplayName, servicesForFilter, terminalCommandPresetKey,
    sortServices,
} from '../src/workspace.ts';

const api = { name: 'api', image: 'my-api', state: 'running', health: '', containers: 1, running_containers: 1, ports: [] };
const db = { ...api, name: 'db', image: 'postgres', state: 'exited', running_containers: 0 };
const worker = { ...api, name: 'worker', health: 'unhealthy' };
const project = { name: 'sample', path: '/projects/sample', has_docker: true, status: 'partial', error: null, services: [api, db, worker] };

test('search matches projects, paths, services and images case insensitively', () => {
    for (const query of ['sample', '/projects', 'API', 'POSTGRES', 'worker']) {
        assert.equal(projectMatches(project, query, 'all'), true);
    }
    assert.equal(projectMatches(project, 'not found', 'all'), false);
    assert.deepEqual(servicesForFilter(project, 'postgres', 'all').map(service => service.name), ['db']);
    assert.equal(servicesForFilter(project, 'sample', 'all').length, 3);
});

test('status filters include relevant services of partially running projects', () => {
    assert.deepEqual(servicesForFilter(project, '', 'active').map(service => service.name), ['api', 'worker']);
    assert.deepEqual(servicesForFilter(project, '', 'stopped').map(service => service.name), ['db']);
    assert.deepEqual(servicesForFilter(project, '', 'failed').map(service => service.name), ['worker']);
    assert.equal(projectMatches(project, 'db', 'active'), false);
    assert.equal(projectMatches(project, 'db', 'stopped'), true);
    assert.equal(projectMatches({ ...project, services: [], error: 'daemon offline' }, '', 'failed'), true);
});

test('services are sorted active-first by default, with name and state alternatives', () => {
    const services = [
        { ...api, name: 'worker' },
        { ...db, name: 'Database' },
        { ...api, name: 'api' },
        { ...db, name: 'cache', state: 'created' },
    ];
    assert.deepEqual(sortServices(services, 'active').map(service => service.name), ['api', 'worker', 'cache', 'Database']);
    assert.deepEqual(sortServices(services, 'name').map(service => service.name), ['api', 'cache', 'Database', 'worker']);
    assert.deepEqual(sortServices(services, 'state').map(service => service.name), ['cache', 'Database', 'api', 'worker']);
    assert.deepEqual(services.map(service => service.name), ['worker', 'Database', 'api', 'cache']);
});

test('favorites and groups roundtrip and malformed local preferences fail explicitly', () => {
    const preferences = { '/projects/sample': { favorite: true, group: 'Trabalho' } };
    assert.deepEqual(parsePreferences(JSON.stringify(preferences)), {
        '/projects/sample': { ...preferences['/projects/sample'], alias: '', aliasPosition: 'prefix' },
    });
    assert.deepEqual(parsePreferences(JSON.stringify({
        '/projects/sample': { favorite: false, group: '', alias: ' PPC ', aliasPosition: 'suffix' },
    })), {
        '/projects/sample': { favorite: false, group: '', alias: 'PPC', aliasPosition: 'suffix' },
    });
    assert.deepEqual(parsePreferences(null), {});
    for (const raw of ['bad json', '[]', 'null', '{"x":{"favorite":"yes","group":1}}']) {
        assert.throws(() => parsePreferences(raw));
    }
    assert.throws(() => parsePreferences('{"x":{"favorite":false,"group":"","alias":1}}'));
    assert.throws(() => parsePreferences('{"x":{"favorite":false,"group":"","aliasPosition":"middle"}}'));
});

test('folder aliases display before or after a project name and match project search', () => {
    assert.equal(projectDisplayName('psp', 'PPC', 'prefix'), 'PPC · psp');
    assert.equal(projectDisplayName('psp', 'PPC', 'suffix'), 'psp · PPC');
    assert.equal(projectDisplayName('psp', '   ', 'prefix'), 'psp');
    const aliasName = projectDisplayName('sample', 'PPC', 'prefix');
    assert.equal(projectMatches(project, 'ppc', 'all', {}, aliasName), true);
    assert.deepEqual(servicesForFilter(project, 'ppc', 'all', {}, aliasName).map(service => service.name), [
        'api', 'db', 'worker',
    ]);
});

test('custom service display names persist and are searchable without changing Docker service keys', () => {
    const names = { '/projects/sample': { api: 'Fênix - API', front: 'Fênix - Frontend' } };
    assert.deepEqual(parseServiceNames(JSON.stringify(names)), names);
    assert.deepEqual(parseServiceNames(null), {});
    assert.equal(serviceDisplayName(names, '/projects/sample', 'api'), 'Fênix - API');
    assert.equal(serviceDisplayName(names, '/projects/sample', 'db'), 'db');
    const namedProject = {
        ...project,
        services: [...project.services, { ...api, name: 'front' }],
    };
    assert.equal(projectMatches(namedProject, 'fênix - api', 'all', names['/projects/sample']), true);
    assert.deepEqual(
        servicesForFilter(namedProject, 'fênix - frontend', 'all', names['/projects/sample']).map(service => service.name),
        ['front'],
    );
    for (const raw of ['bad json', '[]', '{"x":[]} ', '{"x":{"api":1}}']) {
        assert.throws(() => parseServiceNames(raw));
    }
});

test('preferred IDE defaults to WebStorm and rejects unsupported values', () => {
    assert.equal(parsePreferredIDE(null), DEFAULT_IDE);
    assert.deepEqual(IDE_CHOICES.map(ide => ide.id), ['vscode', 'webstorm', 'phpstorm', 'intellij']);
    for (const ide of IDE_CHOICES) assert.equal(parsePreferredIDE(ide.id), ide.id);
    assert.throws(() => parsePreferredIDE('unknown'));
});

test('feature controls default safely and reject malformed stored values', () => {
    assert.equal(defaultFeatureFlags.autoPause, false);
    assert.equal(defaultFeatureFlags.ports, true);
    assert.equal(defaultFeatureFlags.diagnostics, true);
    assert.equal(defaultFeatureFlags.imagePull, true);
    assert.equal(defaultFeatureFlags.projectBuild, true);
    assert.equal(defaultFeatureFlags.containerRecreate, true);
    assert.deepEqual(parseFeatureFlags(JSON.stringify({ ports: false })), { ...defaultFeatureFlags, ports: false });
    assert.deepEqual(parseFeatureFlags(null), defaultFeatureFlags);
    for (const raw of ['bad json', '[]', '{"unknown":true}', '{"autoPause":"yes"}']) {
        assert.throws(() => parseFeatureFlags(raw));
    }
});

test('service presets roundtrip and reject empty or malformed selections', () => {
    const presets = { '/projects/sample': [{ name: 'backend', services: ['api', 'db'] }] };
    assert.deepEqual(parseServicePresets(JSON.stringify(presets)), presets);
    assert.deepEqual(parseServicePresets(null), {});
    for (const raw of ['bad json', '[]', '{"x":[{"name":"empty","services":[]}]}']) {
        assert.throws(() => parseServicePresets(raw));
    }
});

test('terminal command presets are scoped by context, project and service', () => {
    const key = terminalCommandPresetKey('default', '/projects/sample', 'api');
    const presets = { [key]: [{ name: 'Health check', command: 'curl localhost/health' }] };
    assert.equal(key, '["default","/projects/sample","api"]');
    assert.deepEqual(parseTerminalCommandPresets(JSON.stringify(presets)), presets);
    assert.deepEqual(parseTerminalCommandPresets(null), {});
    for (const raw of ['bad json', '[]', '{"api":[{"name":"","command":"ls"}]}', '{"api":[{"name":"List","command":" "}]}']) {
        assert.throws(() => parseTerminalCommandPresets(raw));
    }
});

test('dashboard service selection is context-scoped, deduplicated and validated', () => {
    const key = dashboardSelectionKey('default', '/projects/sample');
    assert.equal(key, '["default","/projects/sample"]');
    assert.deepEqual(parseDashboardSelection(JSON.stringify({ [key]: ['api', 'db', 'api'] })), {
        [key]: ['api', 'db'],
    });
    assert.deepEqual(parseDashboardSelection(null), {});
    for (const raw of ['bad json', '[]', '{"x":"api"}', '{"x":[1]}']) {
        assert.throws(() => parseDashboardSelection(raw));
    }
});

test('recent workspaces are deduplicated, newest-first, bounded and validated', () => {
    const recent = Array.from({ length: 10 }, (_, index) => `/projects/${index}`);
    assert.deepEqual(parseRecentWorkspaces(JSON.stringify(recent)).length, 8);
    assert.deepEqual(parseRecentWorkspaces(null), []);
    assert.deepEqual(parseRecentWorkspaces(JSON.stringify(['/projects/a', '', '/projects/a', '/projects/b'])), [
        '/projects/a', '/projects/b',
    ]);
    assert.deepEqual(rememberWorkspace(recent, '/projects/4'), [
        '/projects/4', '/projects/0', '/projects/1', '/projects/2',
        '/projects/3', '/projects/5', '/projects/6', '/projects/7',
    ]);
    assert.deepEqual(rememberWorkspace(recent, ''), recent.slice(0, 8));
    for (const raw of ['bad json', '{}', '["/projects/a", 1]']) {
        assert.throws(() => parseRecentWorkspaces(raw));
    }
});

test('port addresses use localhost for wildcards and brackets for IPv6', () => {
    assert.equal(portAddress({ host_ip: '0.0.0.0', published: 8080 }), 'localhost:8080');
    assert.equal(portAddress({ host_ip: '::', published: 8080 }), 'localhost:8080');
    assert.equal(portAddress({ host_ip: '::1', published: 8080 }), '[::1]:8080');
    assert.equal(portAddress({ host_ip: '192.168.1.10', published: 80 }), '192.168.1.10:80');
});

test('log search and error-only filters combine without mutating captured lines', () => {
    const lines = ['API ready', 'ERROR database offline', 'worker failed', 'fatal exception', 'failure retry', 'terror is not an error level'];
    assert.deepEqual(filterLogLines(lines, 'DATABASE', true), ['ERROR database offline']);
    assert.deepEqual(filterLogLines(lines, 'API', false), ['API ready']);
    assert.equal(filterLogLines(['ready', 'terror'], '', true).length, 0);
    assert.equal(filterLogLines(lines, '', false).length, lines.length);
    assert.equal(lines.length, 6);
});

test('semantic log errors recognize Portuguese and connection failures without matching substrings', () => {
    for (const line of ['ERROR request failed', 'timeout waiting for service', 'conexão recusada', 'falha ao iniciar', 'exceção inesperada']) {
        assert.equal(isLogError(line), true, line);
    }
    assert.equal(isLogError('terror event'), false);
    assert.equal(isLogError('service ready'), false);
});
