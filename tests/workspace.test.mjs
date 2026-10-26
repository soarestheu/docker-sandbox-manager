import assert from 'node:assert/strict';
import test from 'node:test';
import { filterLogLines, parsePreferences, portAddress, projectMatches, servicesForFilter } from '../src/workspace.ts';

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

test('favorites and groups roundtrip and malformed local preferences fail explicitly', () => {
    const preferences = { '/projects/sample': { favorite: true, group: 'Trabalho' } };
    assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences);
    assert.deepEqual(parsePreferences(null), {});
    for (const raw of ['bad json', '[]', 'null', '{"x":{"favorite":"yes","group":1}}']) {
        assert.throws(() => parsePreferences(raw));
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
