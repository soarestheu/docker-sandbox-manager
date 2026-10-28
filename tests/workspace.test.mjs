import assert from 'node:assert/strict';
import test from 'node:test';
import {
    defaultFeatureFlags, filterLogLines, isLogError, parseFeatureFlags, parsePreferences, portAddress,
    parseServicePresets, projectMatches, servicesForFilter, sortServices,
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
    assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences);
    assert.deepEqual(parsePreferences(null), {});
    for (const raw of ['bad json', '[]', 'null', '{"x":{"favorite":"yes","group":1}}']) {
        assert.throws(() => parsePreferences(raw));
    }
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
