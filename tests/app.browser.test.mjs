import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

function mockTauri() {
    const clone = value => JSON.parse(JSON.stringify(value));
    localStorage.setItem('sandbox-recent-workspaces', JSON.stringify(['/fixture']));
    window.confirmCalls = [];
    window.confirm = message => {
        window.confirmCalls.push(message);
        return true;
    };
    Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: class {
            static permission = 'granted';
            constructor() {}
        },
    });
    const services = ['api', 'db', 'worker'].map(name => ({
        name, image: `example/${name}`, state: 'running', health: '',
        containers: 1, running_containers: 1,
        dependencies: name === 'api' ? ['db'] : [],
        ports: name === 'worker' ? [] : ['0.0.0.0', '::'].map(host_ip => ({
            host_ip, published: name === 'api' ? 8080 : 55432,
            target: name === 'api' ? 3000 : 5432, protocol: 'tcp', is_open: false,
        })),
    }));
    const snapshot = () => ({
        status: services.every(service => service.state === 'running') ? 'running'
            : services.some(service => service.state === 'running') ? 'partial' : 'stopped',
        services: clone(services),
    });
    window.testCalls = [];
    window.failNextAction = false;
    window.setServiceState = (name, state) => {
        const service = services.find(item => item.name === name);
        service.state = state;
        service.running_containers = state === 'running' || state === 'paused' ? 1 : 0;
    };
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 0;
    window.emitLog = (stream_id, log_line) => {
        for (const listener of listeners.values()) {
            if (listener.event === 'docker-log') callbacks.get(listener.handler)?.({ payload: { stream_id, log_line } });
        }
    };
    window.emitTerminalOutput = (stream_id, text) => {
        for (const listener of listeners.values()) {
            if (listener.event === 'docker-terminal-output') callbacks.get(listener.handler)?.({ payload: { stream_id, text } });
        }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { listeners.delete(id); } };
    window.__TAURI_INTERNALS__ = {
        transformCallback: callback => { callbacks.set(++nextId, callback); return nextId; },
        async invoke(command, args) {
            window.testCalls.push({ command, args });
            if (command === 'plugin:event|listen') { listeners.set(++nextId, args); return nextId; }
            if (command === 'plugin:event|unlisten') return;
            if (command === 'plugin:app|version') return '0.5.2';
            if (command === 'plugin:updater|check') return null;
            if (command === 'admin_launch_status') return false;
            if (command === 'set_close_to_tray') return;
            if (command === 'plugin:dialog|open') return '/fixture';
            if (command === 'start_service_logs') {
                if (window.holdNextLogs) {
                    window.holdNextLogs = false;
                    await new Promise(resolve => { window.releaseLogs = resolve; });
                }
                return;
            }
            if (command === 'stop_service_logs') return;
            if (command === 'write_service_terminal') {
                if (args.input.includes('__DSM_EXIT_')) {
                    const marker = args.input.match(/(__DSM_EXIT_[a-f0-9]+_)/)?.[1];
                    if (marker) window.emitTerminalOutput(args.streamId, `${marker}0__\n`);
                } else if (args.input.includes('echo startup')) {
                    window.emitTerminalOutput(args.streamId, 'startup ready\n');
                }
                return;
            }
            if (command === 'start_service_terminal' || command === 'stop_service_terminal'
                || command === 'remove_project_resource') return;
            if (command === 'reset_idle_monitor') return;
            if (command === 'send_state_notification') return;
            if (command === 'get_docker_contexts') return [
                { name: 'default', current: true },
                { name: 'staging', current: false },
            ];
            if (command === 'get_service_metrics') return [
                { name: `${args.service}-1`, id: 'container-id-1', state: 'running', cpu: '1.20%', memory_usage: '20MiB / 1GiB', memory_percent: '2%', network_io: '1kB / 2kB', volumes: [], inspect: {} },
                { name: `${args.service}-2`, id: 'container-id-2', state: 'running', cpu: '0.40%', memory_usage: '10MiB / 1GiB', memory_percent: '1%', network_io: '2kB / 3kB', volumes: [], inspect: {} },
            ];
            if (command === 'diagnose_project') return [
                { severity: 'warning', message: 'Container órfão do serviço old-api.' },
            ];
            if (command === 'get_project_resources') return {
                volumes: [{ name: 'sample_data', resource_type: 'volume', driver: 'local', in_use: true }],
                networks: [{ name: 'sample_default', resource_type: 'network', driver: 'bridge', in_use: false }],
            };
            if (command === 'open_service_http') return;
            if (command === 'open_in_ide') return;
            if (command === 'copy_service_address') { window.copiedAddress = args.address; return; }
            if (command === 'export_service_logs') return `/fixture/Downloads/${args.service}.log`;
            if (command === 'get_default_projects_dir') return '/fixture/default';
            if (command === 'scan_directory') return [{
                name: 'sample', path: '/fixture/sample', has_docker: true,
                error: null, profiles: ['debug'], env_files: ['.env.dev'], ...snapshot(),
            }, ...(window.includeSecondProject ? [{
                name: 'archive', path: '/fixture/archive', has_docker: true,
                error: null, status: 'stopped', services: [],
            }] : [])];
            if (command === 'get_project_state') {
                if (args.projectPath === '/fixture/archive') return { status: 'stopped', services: [] };
                const result = snapshot();
                if (window.holdNextRefresh) {
                    window.holdNextRefresh = false;
                    await new Promise(resolve => { window.releaseRefresh = resolve; });
                }
                return result;
            }
            if (command === 'run_compose_action') {
                if (window.holdNextAction) {
                    window.holdNextAction = false;
                    await new Promise(resolve => { window.releaseAction = resolve; });
                }
                await new Promise(resolve => setTimeout(resolve, 120));
                if (window.failNextAction) {
                    window.failNextAction = false;
                    throw new Error('Compose indisponível');
                }
                for (const service of services) {
                    if (!args.services || args.services.includes(service.name)) {
                        if (['up', 'up_with_deps', 'unpause', 'recreate', 'restart'].includes(args.action)) {
                            service.state = 'running';
                            service.running_containers = 1;
                        } else if (args.action === 'rm') {
                            service.state = 'exited';
                            service.running_containers = 0;
                            service.containers = 0;
                        } else if (['down', 'stop'].includes(args.action)) {
                            service.state = 'exited';
                            service.running_containers = 0;
                        }
                    }
                }
                return snapshot();
            }
            throw new Error(`Unexpected command: ${command}`);
        },
    };
}

test('service selection, scoped actions, stale polling and project stop in the browser', { timeout: 45000 }, async () => {
    const root = resolve('dist');
    const server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(`${root}/`)) {
            response.writeHead(403).end();
            return;
        }
        try {
            const content = await readFile(file);
            const mime = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.woff': 'font/woff', '.woff2': 'font/woff2',
            };
            response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
            response.end(content);
        } catch {
            response.writeHead(404).end();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const profile = await mkdtemp(join(process.cwd(), 'browser-test-'));
    const browser = spawn(process.env.CHROME_BIN || 'chromium', [
        '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let socket;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            let output = '';
            const timeout = setTimeout(() => reject(new Error(`Chromium did not start: ${output}`)), 15000);
            browser.on('error', error => { clearTimeout(timeout); reject(error); });
            browser.stderr.on('data', data => {
                output += data;
                const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) { clearTimeout(timeout); resolve(match[1]); }
            });
        });
        const address = new URL(endpoint);
        const targets = await (await fetch(`http://${address.host}/json/list`)).json();
        const page = targets.find(target => target.type === 'page');
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await once(socket, 'open');
        let id = 0;
        const pending = new Map();
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const waiter = pending.get(message.id);
                if (!waiter) return;
                pending.delete(message.id);
                if (message.error) waiter.reject(new Error(message.error.message));
                else waiter.resolve(message.result);
            }
        });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            pending.set(++id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
        const evaluate = async expression => {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        const waitFor = async expression => {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (await evaluate(expression)) return;
                await delay(50);
            }
            assert.fail(`Timed out: ${expression}`);
        };
        const input = async (selector, value) => evaluate(`(() => {
            const field = document.querySelector(${JSON.stringify(selector)});
            const prototype = field.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, ${JSON.stringify(value)});
            field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
        })()`);
        const toggleServiceMenu = async service => {
            const triggerSelector = `[aria-label="Mais ações do serviço ${service}"]`;
            await evaluate(`(() => {
            const trigger = [...document.querySelectorAll(${JSON.stringify(triggerSelector)})]
                .find(element => element.getClientRects().length > 0);
            trigger.dispatchEvent(
                new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
            );
        })()`);
        };
        const clickServiceMenuAction = async (service, actionLabel) => {
            const triggerSelector = `[aria-label="Mais ações do serviço ${service}"]`;
            const itemSelector = `[role="menuitem"][aria-label="${actionLabel}"]`;
            const visibleTrigger = `([...document.querySelectorAll(${JSON.stringify(triggerSelector)})]
                .find(element => element.getClientRects().length > 0))`;
            const isOpen = await evaluate(
                `[...document.querySelectorAll(${JSON.stringify(triggerSelector)})].some(element =>
                    element.getClientRects().length > 0 && element.getAttribute("data-state") === "open")`,
            );
            if (!isOpen) await toggleServiceMenu(service);
            await waitFor(`${visibleTrigger}?.getAttribute("data-state") === "open"`);
            const scopedItem = `${visibleTrigger} && document.getElementById(${visibleTrigger}.getAttribute("aria-controls"))?.querySelector(${JSON.stringify(itemSelector)})`;
            await waitFor(`!!(${scopedItem})`);
            await evaluate(`(${scopedItem}).click()`);
            await waitFor(`${visibleTrigger}?.getAttribute("data-state") !== "open"`);
            await delay(150);
        };
        const selectTab = async label => evaluate(`(() => {
            const trigger = [...document.querySelectorAll(".screen-switcher button")]
                .find(button => button.textContent.trim() === ${JSON.stringify(label)});
            trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }));
        })()`);
        await send('Page.enable');
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${mockTauri.toString()})()` });
        await send('Page.addScriptToEvaluateOnNewDocument', {
            source: 'localStorage.setItem("sandbox-admin-launch", "true");',
        });
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url });
        await waitFor('document.querySelectorAll(".service-row").length === 3');
        await waitFor('document.querySelector(".app-version")?.textContent === "v0.5.2"');
        assert.equal(await evaluate('localStorage.getItem("sandbox-admin-launch")'), null);
        assert.equal(await evaluate('window.testCalls.some(call => call.command === "reopen_as_admin")'), false);
        await waitFor('document.fonts.check(\'12px "JetBrains Mono"\')');
        await evaluate('document.querySelector(".update-check-button").click()');
        await waitFor('document.querySelector(".update-banner")?.textContent.includes("O aplicativo está atualizado.")');
        assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(15, 23, 41)');
        assert.equal(await evaluate('document.documentElement.classList.contains("dark")'), true);
        assert.equal(await evaluate('document.querySelector(".app-shell").classList.contains("bg-background")'), true);
        assert.ok(await evaluate('document.querySelector(".project-card").classList.contains("bg-card") && document.querySelector(".project-card").classList.contains("border-border")'));
        assert.equal(await evaluate('document.querySelector(".app-dock") !== null'), true);
        assert.ok(await evaluate('getComputedStyle(document.querySelector(".port-value")).fontFamily.includes("JetBrains Mono")'));
        assert.ok(await evaluate('getComputedStyle(document.querySelector(".service-title .status-pill")).fontFamily.includes("JetBrains Mono")'));
        assert.equal(await evaluate(`(() => {
            const buttons = [...document.querySelectorAll(".project-actions .action-icon-button, .service-actions .service-tools-menu")];
            return buttons.length === 4 && buttons.every(button =>
                button.title === button.getAttribute("aria-label")
                    && button.textContent.trim() === "" && !!button.querySelector("svg"));
        })()`), true);
        const projectLayout = await evaluate(`(() => {
            const list = document.querySelector(".project-list").getBoundingClientRect();
            const project = document.querySelector(".project-card").getBoundingClientRect();
            const placeholder = document.querySelector(".project-detail-placeholder").getBoundingClientRect();
            const action = document.querySelector(".project-actions .action-icon-button").getBoundingClientRect();
            const columns = getComputedStyle(document.querySelector(".project-list")).gridTemplateColumns
                .split(" ").map(value => Number.parseFloat(value));
            return {
                columnsFit: columns.length === 2 && columns[0] < columns[1],
                placeholderAtTop: placeholder.top <= project.top + 1,
                placeholderToRight: placeholder.left >= project.right,
                placeholderWithinList: placeholder.right <= list.right + 1,
                actionsRaised: action.top <= project.top + 18,
            };
        })()`);
        assert.deepEqual(projectLayout, {
            columnsFit: true,
            placeholderAtTop: true,
            placeholderToRight: true,
            placeholderWithinList: true,
            actionsRaised: true,
        });
        const initialProjectsCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-projects-initial-desktop.png', Buffer.from(initialProjectsCapture.data, 'base64'));
        assert.equal(await evaluate('window.testCalls.find(call => call.command === "scan_directory").args.basePath'), '/fixture');
        await waitFor('document.querySelector(\'[aria-label="Workspaces recentes"] option[value="/fixture"]\') !== null');
        await evaluate('document.querySelector(".scan-form button").click()');
        await waitFor('window.testCalls.some(call => call.command === "plugin:dialog|open")');
        await waitFor('window.testCalls.filter(call => call.command === "scan_directory").length >= 2');
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "scan_directory").at(-1).args.basePath'), '/fixture');
        await input('[aria-label="Workspaces recentes"]', '/fixture');
        await waitFor('window.testCalls.filter(call => call.command === "scan_directory").length >= 3');
        await evaluate('document.querySelector(".project-info").click()');
        await waitFor('document.querySelector(".service-list").getClientRects().length > 0');
        assert.equal(await evaluate(`(() => {
            const project = document.querySelector(".project-main").getBoundingClientRect();
            const details = document.querySelector(".project-detail-pane").getBoundingClientRect();
            return !document.querySelector(".project-detail-pane").hidden && details.left >= project.right;
        })()`), true);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        assert.equal(await evaluate(`(() => {
            const row = document.querySelector(".service-row");
            const style = getComputedStyle(row);
            return style.display === "grid" && style.columnGap === "10px"
                && style.paddingTop === "10px" && style.paddingLeft === "10px";
        })()`), true);
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await delay(50);
        assert.equal(await evaluate(`(() => {
            const row = document.querySelector(".service-row");
            const actions = document.querySelector(".service-actions");
            return getComputedStyle(row).display === "flex"
                && actions.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1;
        })()`), true);
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
        await input('[aria-label="Contexto Docker"]', 'staging');
        await waitFor('window.testCalls.filter(call => call.command === "scan_directory").at(-1).args.dockerContext === "staging"');
        await input('[aria-label="Contexto Docker"]', 'default');
        await waitFor('window.testCalls.filter(call => call.command === "scan_directory").at(-1).args.dockerContext === "default"');
        await evaluate('document.querySelector(\'.topbar [aria-label="Ativar notificações"]\').click()');
        await waitFor('document.querySelector(\'.topbar [aria-label="Desativar notificações"]\') !== null');
        assert.equal(await evaluate('localStorage.getItem("sandbox-notifications")'), 'true');
        await evaluate('window.setServiceState("api", "exited")');
        await waitFor('window.testCalls.some(call => call.command === "send_state_notification" && call.args.title.includes("Container parado"))');
        await evaluate('window.setServiceState("api", "running")');
        await waitFor('window.testCalls.some(call => call.command === "send_state_notification" && call.args.title.includes("Serviço recuperado"))');
        const stoppedNotificationsBeforeManualAction = await evaluate('window.testCalls.filter(call => call.command === "send_state_notification" && call.args.title.includes("Container parado")).length');
        await evaluate('document.querySelector(\'[aria-label="Parar serviço api de sample"]\').click()');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1)?.args.action === "stop"');
        await waitFor('document.querySelector(\'[aria-label="Iniciar serviço api de sample"]\') !== null');
        assert.equal(
            await evaluate('window.testCalls.filter(call => call.command === "send_state_notification" && call.args.title.includes("Container parado")).length'),
            stoppedNotificationsBeforeManualAction,
        );
        await evaluate('document.querySelector(\'[aria-label="Iniciar serviço api de sample"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Parar serviço api de sample"]\') !== null');
        await evaluate('document.querySelector(\'.topbar [aria-label="Desativar notificações"]\').click()');
        await waitFor('document.querySelector(\'.topbar [aria-label="Ativar notificações"]\') !== null');
        assert.equal(await evaluate('localStorage.getItem("sandbox-notifications")'), 'false');
        await input('[aria-label="Perfis Compose de sample"]', 'debug');
        await waitFor('window.testCalls.filter(call => call.command === "get_project_state").at(-1).args.profiles?.[0] === "debug"');
        await input('[aria-label="Arquivo de ambiente de sample"]', '.env.dev');
        await waitFor('window.testCalls.filter(call => call.command === "get_project_state").at(-1).args.envFile === ".env.dev"');
        await input('[aria-label="Perfis Compose de sample"]', '');
        await input('[aria-label="Arquivo de ambiente de sample"]', '');
        await waitFor('window.testCalls.filter(call => call.command === "get_project_state").at(-1).args.profiles?.length === 0');
        await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].find(button => button.textContent === "Build do projeto").click()');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "build"');
        await waitFor('!document.querySelector(".project-card .lifecycle-actions button").disabled');
        await input('[aria-label="Perfis Compose de sample"]', 'debug');
        await input('[aria-label="Arquivo de ambiente de sample"]', '.env.dev');
        await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].find(button => button.textContent === "Baixar imagens").click()');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "pull"');
        await waitFor('!document.querySelector(".project-card .lifecycle-actions button").disabled');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: ['debug'], envFile: '.env.dev',
            action: 'pull', services: null,
        });
        await input('[aria-label="Perfis Compose de sample"]', '');
        await input('[aria-label="Arquivo de ambiente de sample"]', '');
        await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].find(button => button.textContent === "Diagnosticar").click()');
        await waitFor('document.querySelector(".diagnostic-results")?.textContent.includes("old-api")');
        await evaluate('document.querySelector(\'[aria-label="Fechar diagnóstico de sample"]\').click()');
        await waitFor('document.querySelector(".diagnostic-results") === null');
        await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].find(button => button.textContent === "Volumes e redes").click()');
        await waitFor('document.querySelector(".resource-explorer")?.textContent.includes("sample_default")');
        assert.equal(await evaluate('document.querySelector(".resource-explorer").textContent.includes("em uso")'), true);
        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço api de sample"]\').click()');
        await evaluate('[...document.querySelectorAll(".services-toolbar button")].find(button => button.textContent === "Iniciar com dependências").click()');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "up_with_deps"');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.services'), ['api']);
        await waitFor('!document.querySelector(".project-card .lifecycle-actions button").disabled');
        await waitFor('!document.querySelector(\'[aria-label="Selecionar serviço api de sample"]\').checked');
        assert.equal(await evaluate('document.querySelectorAll(".service-row .service-title .service-image").length'), 0);
        await toggleServiceMenu('api');
        await waitFor('document.querySelector(".service-image-menu-label") !== null');
        assert.equal(await evaluate('document.querySelector(".service-image-menu-label").textContent'), 'Imagem · example/api');
        await clickServiceMenuAction('api', 'Reiniciar serviço api de sample');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "restart"');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: [], envFile: null,
            action: 'restart', services: ['api'],
        });
        await waitFor('!document.querySelector(".project-card .lifecycle-actions button").disabled');
        await clickServiceMenuAction('api', 'Exibir logs de api de sample');
        await waitFor('document.querySelector(".log-panel") !== null');
        await clickServiceMenuAction('api', 'Abrir terminal de api de sample');
        await waitFor('document.querySelector(".terminal-panel")?.textContent.includes("Conectado")');
        assert.equal(await evaluate(`(() => {
            const panels = document.querySelector(".service-inspector-panels");
            return panels.classList.contains("is-split")
                && getComputedStyle(panels).gridTemplateColumns.split(" ").length === 2;
        })()`), true);
        await evaluate('[...document.querySelectorAll(".terminal-panel .utility-heading button")].find(button => button.textContent === "Fechar terminal").click()');
        await waitFor('window.testCalls.some(call => call.command === "stop_service_terminal")');
        await clickServiceMenuAction('api', 'Fechar logs de api de sample');
        await waitFor('window.testCalls.some(call => call.command === "stop_service_logs")');
        await evaluate('document.querySelector(".dependency-graph summary").click()');
        assert.equal(await evaluate('document.querySelector(".dependency-map").textContent.includes("api")'), true);
        await input('[aria-label="Perfis Compose de sample"]', '');
        assert.equal(await evaluate(`(() => {
            const summary = document.querySelector(".summary-bar").getBoundingClientRect();
            const list = document.querySelector(".project-list").getBoundingClientRect();
            return summary.bottom <= list.top;
        })()`), true);
        assert.ok(await evaluate('document.querySelector(".dashboard-health").textContent.includes("Serviços encontrados3")'));
        assert.equal(await evaluate('document.querySelectorAll(".port-chip").length'), 2);
        assert.ok(await evaluate('document.querySelector(".port-chip").textContent.includes("Indisponível")'));
        assert.ok(await evaluate('document.body.textContent.includes("Sem porta publicada")'));
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Ordenar serviços de sample"]\').value'), 'active');
        await input('[aria-label="Ordenar serviços de sample"]', 'name');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Ordenar serviços de sample"]\').value'), 'name');
        await input('[aria-label="Ordenar serviços de sample"]', 'active');
        assert.equal(await evaluate(`window.testCalls.filter(call => call.command === "start_service_logs").length
            === window.testCalls.filter(call => call.command === "stop_service_logs").length`), true);
        assert.ok(await evaluate('document.querySelector(".port-chip").title.includes("0.0.0.0, ::")'));
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").length'), 0);
        await evaluate('document.querySelector(\'.topbar [aria-label="Preferências"]\').click()');
        await waitFor('document.querySelector(\'[role="dialog"]\') !== null');
        await evaluate('document.querySelector(\'[aria-label="Minimizar para bandeja: desativado"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Minimizar para bandeja: ativado"]\') !== null');
        assert.equal(await evaluate('localStorage.getItem("sandbox-close-to-tray")'), 'true');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "set_close_to_tray").at(-1).args'), { enabled: true });
        await evaluate('document.querySelector(\'[aria-label="Minimizar para bandeja: ativado"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Minimizar para bandeja: desativado"]\') !== null');
        assert.equal(await evaluate('localStorage.getItem("sandbox-close-to-tray")'), 'false');
        await input('#preferred-ide', 'phpstorm');
        assert.equal(await evaluate('localStorage.getItem("sandbox-ide")'), 'phpstorm');
        await evaluate('document.querySelector(\'[aria-label="Notificações: desativadas"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Notificações: ativadas"]\') !== null');
        await evaluate('document.querySelector(\'[aria-label="Notificações: ativadas"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Notificações: desativadas"]\') !== null');
        await evaluate('document.querySelector(\'[aria-label="Diagnóstico de projetos: ativado"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Diagnóstico de projetos: desativado"]\') !== null');
        assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].some(button => button.textContent === "Diagnosticar")'), false);
        await evaluate('document.querySelector(\'[aria-label="Diagnóstico de projetos: desativado"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Diagnóstico de projetos: ativado"]\') !== null');
        assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].some(button => button.textContent === "Diagnosticar")'), true);
        await evaluate('document.querySelector(\'[aria-label="Volumes e redes: ativado"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Volumes e redes: desativado"]\') !== null');
        assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].some(button => button.textContent === "Volumes e redes")'), false);
        await evaluate('document.querySelector(\'[aria-label="Volumes e redes: desativado"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Volumes e redes: ativado"]\') !== null');
        assert.equal(await evaluate('[...document.querySelectorAll(".lifecycle-actions button")].some(button => button.textContent === "Volumes e redes")'), true);
        for (const [title, buttonText] of [
            ['Baixar imagens', 'Baixar imagens'],
            ['Build do projeto', 'Build do projeto'],
            ['Recriar containers', 'Recriar containers'],
        ]) {
            await evaluate(`document.querySelector('[aria-label="${title}: ativado"]').click()`);
            await waitFor(`document.querySelector('[aria-label="${title}: desativado"]') !== null`);
            assert.equal(await evaluate(`[...document.querySelectorAll(".lifecycle-actions button")].some(button => button.textContent === ${JSON.stringify(buttonText)})`), false);
            await evaluate(`document.querySelector('[aria-label="${title}: desativado"]').click()`);
            await waitFor(`document.querySelector('[aria-label="${title}: ativado"]') !== null`);
            assert.equal(await evaluate(`[...document.querySelectorAll(".lifecycle-actions button")].some(button => button.textContent === ${JSON.stringify(buttonText)})`), true);
        }
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Pausa por ociosidade: desativado"]\').getAttribute("aria-checked")'), 'false');
        await evaluate('document.querySelector(\'[aria-label="Pausa por ociosidade: desativado"]\').click()');
        await waitFor('document.querySelector(".feature-warning") !== null');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Pausa por ociosidade: ativado"]\').getAttribute("aria-checked")'), 'true');
        await evaluate('document.querySelector(\'[aria-label="Pausa por ociosidade: ativado"]\').click()');
        await evaluate('document.querySelector(".feature-modal .button-primary").click()');
        await evaluate('document.querySelector(\'[aria-label="Mais ações de sample"]\').click()');
        await evaluate('[...document.querySelectorAll(".project-actions .menu-item")].find(button => button.textContent.includes("Abrir na IDE")).click()');
        await waitFor('window.testCalls.some(call => call.command === "open_in_ide")');
        assert.deepEqual(await evaluate('window.testCalls.find(call => call.command === "open_in_ide").args'), {
            projectPath: '/fixture/sample', ide: 'phpstorm',
        });
        await evaluate('document.querySelector(\'.topbar [aria-label="Tema claro"]\').click()');
        assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-shell")).backgroundColor'), 'rgb(241, 244, 248)');
        await delay(500);
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".project-card")).backgroundColor'), 'rgb(255, 255, 255)');
        await evaluate('document.querySelector(\'.topbar [aria-label="Tema escuro"]\').click()');
        assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
        await evaluate('document.querySelector(\'[aria-label="Favoritar projeto sample"]\').click()');
        await input('[aria-label="Grupo de sample"]', 'Trabalho');
        await input('[aria-label="Apelido de sample"]', 'PPC');
        await input('[aria-label="Posição do apelido de sample"]', 'suffix');
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("sandbox-workspace"))["/fixture/sample"].favorite'), true);
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("sandbox-workspace"))["/fixture/sample"].group'), 'Trabalho');
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("sandbox-workspace"))["/fixture/sample"].alias'), 'PPC');
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("sandbox-workspace"))["/fixture/sample"].aliasPosition'), 'suffix');
        assert.equal(await evaluate('document.querySelector(".project-title-row h3").textContent'), 'sample · PPC');
        await input('[aria-label="Buscar projetos ou serviços"]', 'PPC');
        await waitFor('document.querySelectorAll(".project-card").length === 1');
        await input('[aria-label="Buscar projetos ou serviços"]', '');
        await input('[aria-label="Filtrar por grupo"]', 'Trabalho');
        await waitFor('document.querySelectorAll(".project-card").length === 1');
        await input('[aria-label="Filtrar por grupo"]', '');
        await input('[aria-label="Buscar projetos ou serviços"]', 'not-found');
        await waitFor('document.querySelectorAll(".project-card").length === 0');
        await input('[aria-label="Buscar projetos ou serviços"]', 'db');
        await waitFor('document.querySelectorAll(".service-row").length === 1');
        await evaluate('document.querySelector(\'[aria-label="Selecionar todos os serviços de sample"]\').click()');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').checked'), true);
        await input('[aria-label="Buscar projetos ou serviços"]', '');
        await waitFor('document.querySelectorAll(".service-row").length === 3');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".service-row")).display'), 'grid');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').checked'), false);
        await evaluate('document.querySelector(\'.chip[data-status="failed"]\').click()');
        await waitFor('document.querySelectorAll(".project-card").length === 0');
        await evaluate('document.querySelector(\'.chip[data-status="all"]\').click()');
        await waitFor('document.querySelectorAll(".service-row").length === 3');
        await evaluate('document.querySelector(\'[aria-label="Copiar endereço localhost:8080 de api"]\').click()');
        await waitFor('window.copiedAddress === "localhost:8080"');
        await evaluate('document.querySelector(\'[aria-label="Abrir HTTP localhost:8080 de api"]\').click()');
        await waitFor('window.testCalls.some(call => call.command === "open_service_http")');
        assert.deepEqual(await evaluate('window.testCalls.find(call => call.command === "open_service_http").args'), { host: '0.0.0.0', port: 8080, https: false });
        await clickServiceMenuAction('db', 'Exibir métricas de db de sample');
        await waitFor('document.querySelectorAll(".metric-card").length === 2');
        assert.ok(await evaluate('document.querySelector(".metrics-panel").textContent.includes("20MiB / 1GiB")'));
        assert.ok(await evaluate('document.querySelector(".metric-card .status-pill.status-up") !== null'));
        await waitFor('Object.values(JSON.parse(localStorage.getItem("sandbox-metric-history"))).some(samples => samples.length > 0)');
        await input('[aria-label="Limite de alerta de CPU de db"]', '1');
        await waitFor('document.querySelector(".metric-warning") !== null');
        assert.ok(await evaluate('document.querySelector(".metric-warning.status-warn") !== null'));
        assert.ok(await evaluate('Object.keys(localStorage).some(key => key.startsWith("sandbox-metric-thresholds:"))'));
        const metricCallsBeforeRefresh = await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").length');
        await evaluate('[...document.querySelectorAll(".metrics-panel button")].find(button => button.textContent === "Atualizar agora").click()');
        await waitFor(`window.testCalls.filter(call => call.command === "get_service_metrics").length > ${metricCallsBeforeRefresh}`);
        await evaluate('document.querySelector(".metrics-panel .utility-actions button:last-child").click()');
        await waitFor('document.querySelector(".metrics-panel") === null');
        await evaluate('window.setServiceState("api", "paused")');
        await waitFor('document.querySelector(\'[aria-label="Retomar serviço api de sample"]\') !== null');
        await evaluate('document.querySelector(\'[aria-label="Retomar serviço api de sample"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Parar serviço api de sample"]\') !== null');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: [], envFile: null,
            action: 'unpause', services: ['api'],
        });

        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').click()');
        await evaluate('document.querySelector(\'[aria-label="Recolher projeto sample · PPC"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Expandir projeto sample · PPC"]\')?.getAttribute("aria-expanded") === "false"');
        assert.equal(await evaluate('document.querySelector(".service-list").getClientRects().length'), 0);
        assert.equal(await evaluate('document.querySelector(".project-actions .action-icon-button.is-danger").getClientRects().length > 0'), true);
        await evaluate('document.querySelector(\'[aria-label="Expandir projeto sample · PPC"]\').click()');
        await waitFor('document.querySelector(".service-list").getClientRects().length > 0');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').checked'), true);
        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').click()');
        assert.equal(await evaluate('document.querySelector(".service-action-label")?.textContent'), 'Dashboard');
        await clickServiceMenuAction('db', 'Abrir terminal de db de sample');
        await waitFor('document.querySelector(".terminal-panel")?.textContent.includes("Conectado")');
        const terminalStream = await evaluate('window.testCalls.filter(call => call.command === "start_service_terminal").at(-1).args');
        await evaluate(`window.emitTerminalOutput(${JSON.stringify(terminalStream.streamId)}, "old terminal output\\n")`);
        await waitFor('document.querySelector(".terminal-output")?.textContent.includes("old terminal output")');
        const terminalStartsBeforeNavigation = await evaluate('window.testCalls.filter(call => call.command === "start_service_terminal").length');
        await selectTab('Dashboard');
        await waitFor('document.querySelector(".dashboard-screen") !== null');
        assert.ok(await evaluate('document.querySelector(".terminal-output")?.textContent.includes("old terminal output")'));
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "start_service_terminal").length'), terminalStartsBeforeNavigation);
        await selectTab('Projetos');
        await waitFor('document.querySelector(".dashboard-screen").hidden');
        await evaluate('document.querySelector(\'[aria-label="Limpar terminal de db"]\').click()');
        assert.equal(await evaluate('document.querySelector(".terminal-output").textContent'), 'Digite um comando para começar.');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Recolher projeto sample · PPC"]\')?.getAttribute("aria-expanded")'), 'true');
        await evaluate('document.querySelector(\'[aria-label="Recolher projeto sample · PPC"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Expandir projeto sample · PPC"]\')?.getAttribute("aria-expanded") === "false"');
        assert.ok(await evaluate('document.querySelector(".terminal-panel") !== null'));
        await evaluate('document.querySelector(\'[aria-label="Expandir projeto sample · PPC"]\').click()');
        await waitFor('document.querySelector(\'[aria-label="Recolher projeto sample · PPC"]\')?.getAttribute("aria-expanded") === "true"');
        const startsBeforeDbLogs = await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").length');
        await clickServiceMenuAction('db', 'Exibir logs de db de sample');
        await waitFor(`window.testCalls.filter(call => call.command === "start_service_logs").length > ${startsBeforeDbLogs}`);
        assert.ok(await evaluate('document.querySelector(".terminal-panel") !== null'));
        assert.ok(await evaluate('document.querySelector(".log-panel") !== null'));
        await evaluate('[...document.querySelectorAll(".terminal-panel .utility-heading button")].find(button => button.textContent === "Fechar terminal").click()');
        await waitFor('document.querySelector(".terminal-panel") === null');
        assert.ok(await evaluate('document.querySelector(".log-panel") !== null'));
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Recolher projeto sample · PPC"]\')?.getAttribute("aria-expanded")'), 'true');
        const dbStream = await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").at(-1).args');
        assert.equal(dbStream.service, 'db');
        await evaluate(`window.emitLog(${JSON.stringify(dbStream.streamId)}, "database ready"); window.emitLog("unrelated-stream", "wrong service");`);
        await waitFor('document.querySelector(".log-output")?.textContent.includes("database ready")');
        assert.equal(await evaluate('document.querySelector(".log-output").textContent.includes("wrong service")'), false);
        await evaluate(`for (let i = 1; i <= 120; i++) window.emitLog(${JSON.stringify(dbStream.streamId)}, "db line " + i);`);
        await waitFor('document.querySelectorAll(".log-line").length === 100');
        assert.ok(await evaluate('document.querySelector(".log-line").textContent.includes("db line 21")'));
        await evaluate(`window.emitLog(${JSON.stringify(dbStream.streamId)}, "ERROR database offline"); window.emitLog(${JSON.stringify(dbStream.streamId)}, "ERROR api offline");`);
        await waitFor('document.querySelector(".log-output").textContent.includes("ERROR api offline")');
        await input('[aria-label="Buscar nos logs de db"]', 'database');
        await evaluate('document.querySelector(".log-toolbar input[type=checkbox]").click()');
        await waitFor('document.querySelectorAll(".log-line").length === 1');
        await evaluate('[...document.querySelectorAll(".log-toolbar button")].find(button => button.textContent === "Exportar exibidos").click()');
        await waitFor('document.querySelector(".utility-feedback")?.textContent.includes("/fixture/Downloads/db.log")');
        assert.equal(await evaluate('window.testCalls.find(call => call.command === "export_service_logs").args.content'), 'ERROR database offline\n');
        const startsBeforeApiLogs = await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").length');
        await clickServiceMenuAction('api', 'Exibir logs de api de sample');
        await waitFor(`window.testCalls.some(call => call.command === "stop_service_logs" && call.args.streamId === ${JSON.stringify(dbStream.streamId)})`);
        await waitFor(`window.testCalls.filter(call => call.command === "start_service_logs").length > ${startsBeforeApiLogs}`);
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").length'), startsBeforeApiLogs + 1);
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").at(-1).args.service'), 'api');
        assert.equal(await evaluate('document.querySelectorAll(".log-panel").length'), 1);
        const stopsBeforeCollapse = await evaluate('window.testCalls.filter(call => call.command === "stop_service_logs").length');
        await evaluate('document.querySelector(\'[aria-label="Recolher projeto sample · PPC"]\').click()');
        await waitFor(`window.testCalls.filter(call => call.command === "stop_service_logs").length > ${stopsBeforeCollapse}`);
        assert.equal(await evaluate('document.querySelector(".log-panel")'), null);
        await evaluate('document.querySelector(\'[aria-label="Expandir projeto sample · PPC"]\').click()');
        assert.equal(await evaluate('document.querySelector(".log-panel")'), null);

        const startsBeforePendingLogs = await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").length');
        await evaluate('window.holdNextLogs = true');
        await clickServiceMenuAction('db', 'Exibir logs de db de sample');
        await waitFor('typeof window.releaseLogs === "function"');
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").length'), startsBeforePendingLogs + 1);
        const pendingStream = await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").at(-1).args.streamId');
        await clickServiceMenuAction('db', 'Fechar logs de db de sample');
        await evaluate('window.releaseLogs()');
        await waitFor(`window.testCalls.some(call => call.command === "stop_service_logs" && call.args.streamId === ${JSON.stringify(pendingStream)})`);

        // Keep an old running snapshot in flight while stopping a selection.
        await evaluate('window.holdNextRefresh = true');
        await waitFor('typeof window.releaseRefresh === "function"');
        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').click()');
        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço worker de sample"]\').click()');
        await evaluate('[...document.querySelectorAll(".services-toolbar button")].find(button => button.textContent === "Parar selecionados").click()');
        assert.equal(await evaluate('[...document.querySelectorAll(".service-actions > button.action-icon-button")].every(button => button.disabled)'), true);
        await waitFor('document.querySelector(\'[aria-label="Iniciar serviço db de sample"]\') !== null');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.services'), ['db', 'worker']);
        assert.ok(await evaluate('document.querySelector(\'[aria-label="Parar serviço api de sample"]\') !== null'));
        assert.ok(await evaluate('document.querySelector(".project-title-row").textContent.includes("Execução parcial")'));
        assert.ok(await evaluate('document.body.textContent.includes("Serviço parado")'));
        await evaluate('window.releaseRefresh()');
        await delay(100);
        assert.ok(await evaluate('document.querySelector(\'[aria-label="Iniciar serviço db de sample"]\') !== null'));

        await waitFor('!document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').checked && !document.querySelector(\'[aria-label="Selecionar serviço worker de sample"]\').checked');
        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').click(); document.querySelector(\'[aria-label="Selecionar serviço worker de sample"]\').click()');
        await evaluate('window.holdNextAction = true; [...document.querySelectorAll(".services-toolbar button")].find(button => button.textContent === "Iniciar selecionados").click()');
        await waitFor('document.querySelectorAll(".service-row[aria-busy=true]").length === 2');
        assert.equal(await evaluate('[...document.querySelectorAll(".service-actions > button.action-icon-button")].filter(button => button.getAttribute("aria-busy") === "true").length'), 2);
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Parar serviço api de sample"]\').textContent.trim()'), '');
        assert.equal(await evaluate('document.querySelector(".project-actions .action-icon-button.is-danger").textContent.trim()'), '');
        await evaluate('window.releaseAction()');
        await waitFor('document.querySelector(\'[aria-label="Parar serviço db de sample"]\') !== null');
        assert.ok(await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").length >= 2'));
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: [], envFile: null,
            action: 'up', services: ['db', 'worker'],
        });

        await evaluate('window.failNextAction = true; document.querySelector(\'[aria-label="Parar serviço api de sample"]\').click()');
        await waitFor('document.querySelector(".notice")?.textContent.includes("Compose indisponível")');
        assert.ok(await evaluate('document.querySelector(\'[aria-label="Parar serviço api de sample"]\') !== null'));
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Parar serviço api de sample"]\').disabled'), false);

        await evaluate('document.querySelector(".project-actions .action-icon-button.is-danger").click()');
        await waitFor('document.querySelector(".project-actions .action-icon-button.is-start") !== null');
        assert.equal(await evaluate('document.querySelectorAll(".service-actions > button[aria-label^=\\"Iniciar serviço\\"]").length'), 3);
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.services'), null);

        await evaluate('window.holdNextAction = true; document.querySelector(\'[aria-label="Iniciar serviço db de sample"]\').click()');
        await waitFor('document.querySelectorAll(".service-row[aria-busy=true]").length === 1');
        assert.equal(await evaluate('[...document.querySelectorAll(".service-actions > button.action-icon-button")].filter(button => button.getAttribute("aria-busy") === "true").length'), 1);
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Iniciar serviço api de sample"]\').textContent.trim()'), '');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Iniciar serviço worker de sample"]\').textContent.trim()'), '');
        assert.equal(await evaluate('document.querySelector(".project-actions .action-icon-button.is-start").textContent.trim()'), '');
        await evaluate('window.releaseAction()');
        await waitFor('document.querySelector(\'[aria-label="Parar serviço db de sample"]\') !== null');
        await evaluate('document.querySelector(\'[aria-label="Selecionar serviço db de sample"]\').click(); document.querySelector(\'[aria-label="Selecionar serviço worker de sample"]\').click()');
        await input('[aria-label="Nome da predefinição de sample"]', 'backend');
        await evaluate('[...document.querySelectorAll(".preset-controls button")].find(button => button.textContent === "Salvar preset").click()');
        assert.ok(await evaluate('JSON.parse(localStorage.getItem("sandbox-service-presets"))["/fixture/sample"].some(preset => preset.name === "backend")'));
        await evaluate('[...document.querySelectorAll(".preset-controls button")].find(button => button.textContent === "Parar preset").click()');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "stop"');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.services'), ['db', 'worker']);
        await waitFor('!document.querySelector(".project-card .lifecycle-actions button").disabled');
        await evaluate('[...document.querySelectorAll(".preset-controls button")].find(button => button.textContent === "Iniciar preset").click()');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "up"');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.services'), ['db', 'worker']);
        await waitFor('!document.querySelector(".project-card .lifecycle-actions button").disabled');

        const dashboardMetricsBefore = await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").length');
        await evaluate('document.querySelector(\'[aria-label="Acompanhar serviço db de sample no Dashboard"]\').click()');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Acompanhar serviço db de sample no Dashboard"]\')?.getAttribute("aria-checked")'), 'true');
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").length'), dashboardMetricsBefore);
        await selectTab('Dashboard');
        await waitFor('!document.querySelector(".dashboard-screen").hidden');
        await waitFor(`window.testCalls.filter(call => call.command === "get_service_metrics").length > ${dashboardMetricsBefore}`);
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: [], envFile: null, service: 'db',
        });
        await waitFor('document.querySelector(".dashboard-container-row")?.textContent.includes("20MiB / 1GiB")');
        assert.equal(await evaluate('document.querySelectorAll(".dashboard-service-card").length'), 1);
        assert.ok(await evaluate('document.querySelector(".dashboard-overview").textContent.includes("30.0 MiB")'));
        assert.equal(await evaluate('document.querySelectorAll(".dashboard-kpi").length'), 3);
        assert.equal(await evaluate('document.querySelector(".dashboard-kpi-cpu strong").textContent'), '1.6%');
        assert.equal(await evaluate('document.querySelector(".dashboard-kpi-ports strong").textContent'), '0');
        assert.ok(await evaluate('document.querySelector(".dashboard-service-title .status-pill").classList.contains("status-up")'));
        assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Dashboard overflow at desktop');
        const dashboardCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-dashboard-desktop.png', Buffer.from(dashboardCapture.data, 'base64'));
        await clickServiceMenuAction('db', 'Reiniciar serviço db de sample');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "restart"');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: [], envFile: null,
            action: 'restart', services: ['db'],
        });
        await waitFor('!document.querySelector(".dashboard-service-actions button").disabled');
        const stoppedLogStreamsBefore = await evaluate('window.testCalls.filter(call => call.command === "stop_service_logs").length');
        await evaluate('[...document.querySelectorAll(".dashboard-service-actions button")].find(button => button.textContent === "Exibir logs").click()');
        await waitFor('window.testCalls.some(call => call.command === "start_service_logs" && call.args.service === "db")');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".log-output")).backgroundColor'), 'rgb(23, 30, 49)');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Limpar logs de db"]\').disabled'), true);
        const dashboardLogStream = await evaluate('window.testCalls.filter(call => call.command === "start_service_logs").at(-1).args.streamId');
        await evaluate(`for (let index = 0; index < 50; index++) window.emitLog(${JSON.stringify(dashboardLogStream)}, \`dashboard line \${index}\`)`);
        await waitFor('document.querySelector(".log-output")?.textContent.includes("dashboard line 49")');
        await waitFor(`(() => {
            const output = document.querySelector(".log-output");
            return output.scrollHeight > output.clientHeight
                && output.scrollTop >= output.scrollHeight - output.clientHeight - 1;
        })()`);
        const logsCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-dashboard-logs.png', Buffer.from(logsCapture.data, 'base64'));
        await evaluate('document.querySelector(\'.topbar [aria-label="Tema claro"]\').click()');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".log-output")).backgroundColor'), 'rgb(16, 17, 22)');
        const lightLogsCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-dashboard-logs-light.png', Buffer.from(lightLogsCapture.data, 'base64'));
        await evaluate('document.querySelector(\'.topbar [aria-label="Tema escuro"]\').click()');
        await evaluate('document.querySelector(\'[aria-label="Limpar logs de db"]\').click()');
        assert.equal(await evaluate('document.querySelector(".log-line")'), null);
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Limpar logs de db"]\').disabled'), true);
        await clickServiceMenuAction('db', 'Abrir terminal de db de sample');
        await waitFor('document.querySelector(".terminal-panel")?.textContent.includes("Conectado")');
        assert.ok(await evaluate('document.querySelector(".terminal-panel") !== null'));
        await clickServiceMenuAction('db', 'Fechar terminal de db de sample');
        await evaluate('[...document.querySelectorAll(".dashboard-service-actions button")].find(button => button.textContent === "Fechar logs").click()');
        await waitFor(`window.testCalls.filter(call => call.command === "stop_service_logs").length > ${stoppedLogStreamsBefore}`);
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("sandbox-dashboard-selection"))[JSON.stringify(["default", "/fixture/sample"])][0]'), 'db');
        await selectTab('Projetos');
        await waitFor('document.querySelector(".dashboard-screen").hidden');
        await delay(250);
        const projectsCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-projects-desktop.png', Buffer.from(projectsCapture.data, 'base64'));

        for (const width of [1100, 900, 640]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
            await delay(100);
            assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `Overflow at ${width}px`);
        }

        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await delay(100);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        assert.equal(await evaluate(`(() => {
            const dock = document.querySelector(".app-dock").getBoundingClientRect();
            const tools = document.querySelector(".topbar-tools").getBoundingClientRect();
            return dock.bottom <= tools.top;
        })()`), true, 'Mobile navigation overlaps the topbar controls');
        await selectTab('Dashboard');
        await waitFor('!document.querySelector(".dashboard-screen").hidden');
        assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        assert.equal(await evaluate(`(() => {
            const dock = document.querySelector(".app-dock").getBoundingClientRect();
            const tools = document.querySelector(".topbar-tools").getBoundingClientRect();
            return dock.bottom <= tools.top;
        })()`), true, 'Mobile navigation overlaps the topbar controls');
        const mobileDashboardCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-dashboard-mobile.png', Buffer.from(mobileDashboardCapture.data, 'base64'));
        await selectTab('Projetos');
        await waitFor('document.querySelector(".dashboard-screen").hidden');
        await delay(250);
        const mobileProjectsCapture = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/dsm-projects-mobile.png', Buffer.from(mobileProjectsCapture.data, 'base64'));
        assert.equal(await evaluate(`(() => {
            const starts = window.testCalls.filter(call => call.command === "start_service_logs");
            const stops = new Set(window.testCalls.filter(call => call.command === "stop_service_logs")
                .map(call => call.args.streamId));
            return starts.length === new Set(starts.map(call => call.args.streamId)).size
                && starts.every(call => stops.has(call.args.streamId));
        })()`), true);
        assert.ok(await evaluate('window.testCalls.filter(call => call.command === "get_service_metrics").length >= 2'));
        await evaluate('window.includeSecondProject = true; document.querySelector(".scan-button").click()');
        await waitFor('document.querySelectorAll(".project-card").length === 2');
        await evaluate('[...document.querySelectorAll(".chip")].find(chip => chip.textContent.includes("Favoritos")).click()');
        await waitFor('document.querySelectorAll(".project-card").length === 1');
        assert.equal(await evaluate('document.querySelector(".project-title-row h3").textContent'), 'sample · PPC');
        await evaluate('document.querySelector(\'[aria-label="Selecionar projetos visíveis"]\').click()');
        await waitFor('document.querySelector(".selection-bar .button-danger") !== null');
        await evaluate('document.querySelector(".selection-bar .button-danger").click()');
        await waitFor('document.querySelector(".notice")?.textContent.includes("finalizada com sucesso")');
        await waitFor('document.querySelector(".selection-bar") === null');
        assert.equal(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.projectPath'), '/fixture/sample');
        assert.equal(await evaluate('window.testCalls.some(call => call.command === "run_compose_action" && call.args.projectPath === "/fixture/archive")'), false);
        await send('Page.reload');
        await waitFor('document.querySelector(\'[aria-label="Grupo de sample"]\')?.value === "Trabalho"');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Favoritar projeto sample · PPC"]\').getAttribute("aria-pressed")'), 'true');
        await selectTab('Dashboard');
        await waitFor('document.querySelector(".dashboard-service-card h2")?.textContent === "db"');
        await clickServiceMenuAction('db', 'Abrir terminal de db de sample');
        await waitFor('document.querySelector(".terminal-panel")?.textContent.includes("Conectado")');
        await input('[aria-label="Comando no terminal de db"]', 'echo healthy');
        await evaluate('document.querySelector(".terminal-presets summary").click()');
        await evaluate('document.querySelector(".terminal-input-row button").click()');
        await waitFor('window.testCalls.some(call => call.command === "write_service_terminal" && call.args.input === "echo healthy\\n")');
        await input('[aria-label="Nome do comando salvo para db"]', 'Health check');
        assert.equal(await evaluate('[...document.querySelectorAll(".terminal-preset-form button")].find(button => button.textContent === "Adicionar comando").disabled'), false);
        await evaluate('[...document.querySelectorAll(".terminal-preset-form button")].find(button => button.textContent === "Adicionar comando").click()');
        const terminalPresetKey = '["default","/fixture/sample","db"]';
        assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("sandbox-terminal-command-presets"))[${JSON.stringify(terminalPresetKey)}]`), [
            { name: 'Health check', command: 'echo healthy', autoExecute: false },
        ]);
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Executar comando rápido Health check no terminal de db"]\').disabled'), false);
        await evaluate('document.querySelector(\'[aria-label="Executar comando rápido Health check no terminal de db"]\').click()');
        await waitFor('window.testCalls.some(call => call.command === "write_service_terminal" && call.args.input === "echo healthy\\n")');
        await input('[aria-label="Nome do comando salvo para db"]', 'Startup check');
        await input('[aria-label="Comando a salvar para db"]', 'echo startup');
        await evaluate('document.querySelector(\'[aria-label="Executar automaticamente Startup check ao iniciar db"]\').click()');
        await evaluate('[...document.querySelectorAll(".terminal-preset-form button")].find(button => button.textContent === "Adicionar comando").click()');
        assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem("sandbox-terminal-command-presets"))[${JSON.stringify(terminalPresetKey)}]`), [
            { name: 'Health check', command: 'echo healthy', autoExecute: false },
            { name: 'Startup check', command: 'echo startup', autoExecute: true },
        ]);
        assert.equal(await evaluate('document.querySelector(\'[aria-label="Executar comando rápido Startup check no terminal de db"]\').disabled'), true);
        await clickServiceMenuAction('db', 'Remover containers de db de sample');
        await waitFor('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args.action === "rm"');
        assert.deepEqual(await evaluate('window.testCalls.filter(call => call.command === "run_compose_action").at(-1).args'), {
            projectPath: '/fixture/sample', dockerContext: 'default', profiles: [], envFile: null,
            action: 'rm', services: ['db'],
        });
        assert.match(await evaluate('window.confirmCalls.at(-1)'), /Volumes não serão removidos/);
        await waitFor('document.querySelector(".terminal-panel") === null');
        await waitFor('window.testCalls.some(call => call.command === "stop_service_terminal")');
        await selectTab('Projetos');
        await waitFor('document.querySelector(".dashboard-screen").hidden');
        await evaluate('document.querySelector(\'[aria-label="Expandir projeto sample · PPC"]\')?.click()');
        await waitFor('document.querySelector(\'[aria-label="Iniciar serviço db de sample"]\') !== null');
        await evaluate('document.querySelector(\'[aria-label="Iniciar serviço db de sample"]\').click()');
        await waitFor('window.testCalls.some(call => call.command === "write_service_terminal" && call.args.input === "echo startup\\n")');
        assert.ok(await evaluate('window.testCalls.some(call => call.command === "start_service_terminal" && call.args.service === "db")'));
        await waitFor('document.querySelector(".terminal-auto-result")?.textContent === "Executado"');
        assert.match(await evaluate('document.querySelector(".terminal-output").textContent'), /startup ready/);
        await evaluate('document.querySelector(\'[aria-label="Fechar mensagem de execução automática Startup check"]\').click()');
        await waitFor('document.querySelector(".terminal-auto-result") === null');
    } finally {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
            socket.close();
        }
        if (browser.exitCode === null) {
            await Promise.race([once(browser, 'exit'), delay(3000)]);
            if (browser.exitCode === null) browser.kill('SIGTERM');
        }
        server.close();
        await rm(profile, { recursive: true, force: true });
    }
});
