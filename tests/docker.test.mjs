import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPorts, isProjectActive, isServiceActive, portStateLabel, serviceStateLabel } from '../src/docker.ts';

const service = {
    name: 'database',
    image: 'postgres',
    state: 'running',
    health: '',
    containers: 1,
    running_containers: 1,
    ports: [],
};
const port = {
    host_ip: '127.0.0.1',
    published: 55432,
    target: 5432,
    protocol: 'tcp',
    is_open: false,
};

test('closed ports are unavailable, not indefinitely checking', () => {
    assert.equal(portStateLabel(service, port), 'Indisponível');
    assert.equal(portStateLabel(service, { ...port, is_open: true }), 'Disponível');
    assert.equal(portStateLabel(service, { ...port, is_open: null }), 'Sem verificação');
});

test('stopping a service changes its label and action, preserving its port mapping', () => {
    const stopped = { ...service, state: 'exited', running_containers: 0, ports: [port] };
    assert.equal(serviceStateLabel(stopped), 'Parado');
    assert.equal(isServiceActive(stopped), false);
    assert.equal(portStateLabel(stopped, port), 'Serviço parado');
    assert.equal(stopped.ports[0].published, 55432);
});

test('UDP ports are not incorrectly reported as failed TCP connections', () => {
    assert.equal(portStateLabel(service, { ...port, protocol: 'udp', is_open: null }), 'UDP · sem teste TCP');
});

test('uncreated and portless services can be started', () => {
    const uncreated = { ...service, state: 'not_created', containers: 0, running_containers: 0 };
    assert.equal(serviceStateLabel(uncreated), 'Não iniciado');
    assert.equal(isServiceActive(uncreated), false);
    assert.equal(isServiceActive(service), true);
});

test('partial, paused and restarting services remain stoppable', () => {
    for (const state of ['partial', 'paused', 'restarting']) {
        assert.equal(isServiceActive({ ...service, state }), true);
    }
    assert.equal(isProjectActive({ status: 'partial', services: [service] }), true);
    assert.equal(isProjectActive({ status: 'stopped', services: [] }), false);
});

test('health has its own label instead of being confused with TCP availability', () => {
    assert.equal(serviceStateLabel({ ...service, health: 'unhealthy' }), 'Não saudável');
    assert.equal(serviceStateLabel({ ...service, health: 'starting' }), 'Inicializando');
    assert.equal(serviceStateLabel({ ...service, health: 'healthy' }), 'Em execução');
});

test('IPv4 and IPv6 wildcard bindings produce a single tag with both addresses', () => {
    const result = displayPorts([
        { ...port, host_ip: '0.0.0.0' },
        { ...port, host_ip: '::', is_open: true },
        { ...port, host_ip: '0.0.0.0' },
    ]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].host_ips, ['0.0.0.0', '::']);
    assert.equal(result[0].is_open, true);
});

test('different host addresses, protocols, targets and published ports remain distinct', () => {
    assert.equal(displayPorts([
        port,
        { ...port, host_ip: '192.168.1.10' },
        { ...port, protocol: 'udp' },
        { ...port, target: 8080 },
        { ...port, published: 55433 },
    ]).length, 5);
    assert.equal(displayPorts([port, { ...port }]).length, 1);
});
