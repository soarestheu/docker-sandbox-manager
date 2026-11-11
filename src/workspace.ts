import { isProjectActive, isServiceActive } from './docker.ts';
import type { ComposeService, Project, ServicePort } from './docker';

export interface ProjectPreference {
    favorite: boolean;
    group: string;
    alias: string;
    aliasPosition: ProjectAliasPosition;
}

export type ProjectAliasPosition = 'prefix' | 'suffix';
export type Preferences = Record<string, ProjectPreference>;
export type ServiceNames = Record<string, Record<string, string>>;
export const IDE_CHOICES = [
    { id: 'vscode', label: 'Visual Studio Code' },
    { id: 'webstorm', label: 'WebStorm' },
    { id: 'phpstorm', label: 'PhpStorm' },
    { id: 'intellij', label: 'IntelliJ IDEA' },
] as const;
export type PreferredIDE = typeof IDE_CHOICES[number]['id'];
export const DEFAULT_IDE: PreferredIDE = 'webstorm';

function isPreferredIDE(value: string): value is PreferredIDE {
    return IDE_CHOICES.some(ide => ide.id === value);
}

export function parsePreferredIDE(raw: string | null): PreferredIDE {
    if (!raw) return DEFAULT_IDE;
    if (!isPreferredIDE(raw)) throw new Error('IDE padrão local inválida.');
    return raw;
}

export interface ProjectComposeOptions {
    profiles: string[];
    envFile: string | null;
}
export type ProjectComposeOptionsMap = Record<string, ProjectComposeOptions>;
export type DashboardSelection = Record<string, string[]>;
export interface ServicePreset {
    name: string;
    services: string[];
}
export type ServicePresets = Record<string, ServicePreset[]>;
export interface TerminalCommandPreset {
    name: string;
    command: string;
    autoExecute: boolean;
}
export type TerminalCommandPresets = Record<string, TerminalCommandPreset[]>;
export const MAX_RECENT_WORKSPACES = 8;
export type StatusFilter = 'all' | 'active' | 'stopped' | 'failed';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

export function dashboardSelectionKey(context: string, projectPath: string): string {
    return JSON.stringify([context, projectPath]);
}

export function terminalCommandPresetKey(context: string, projectPath: string, service: string): string {
    return JSON.stringify([context, projectPath, service]);
}

export function parseDashboardSelection(raw: string | null): DashboardSelection {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error('Seleção do dashboard inválida.');
    const selection: DashboardSelection = {};
    for (const [key, services] of Object.entries(value)) {
        if (!isStringArray(services)) throw new Error('Seleção do dashboard inválida.');
        selection[key] = [...new Set(services)];
    }
    return selection;
}

export function parseRecentWorkspaces(raw: string | null): string[] {
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(path => typeof path === 'string')) {
        throw new Error('Histórico de workspaces inválido.');
    }
    return [...new Set(value.filter(path => path.trim()))].slice(0, MAX_RECENT_WORKSPACES);
}

export function rememberWorkspace(recent: string[], path: string): string[] {
    if (!path.trim()) return recent.slice(0, MAX_RECENT_WORKSPACES);
    return [path, ...recent.filter(item => item !== path)]
        .slice(0, MAX_RECENT_WORKSPACES);
}

export type ServiceSort = 'active' | 'name' | 'state';

export interface FeatureFlags {
    directory: boolean;
    theme: boolean;
    containerId: boolean;
    ports: boolean;
    metrics: boolean;
    inspect: boolean;
    volumes: boolean;
    state: boolean;
    autoPause: boolean;
    semanticErrors: boolean;
    diagnostics: boolean;
    imagePull: boolean;
    projectBuild: boolean;
    containerRecreate: boolean;
}

export const defaultFeatureFlags: FeatureFlags = {
    directory: true,
    theme: true,
    containerId: true,
    ports: true,
    metrics: true,
    inspect: true,
    volumes: true,
    state: true,
    autoPause: false,
    semanticErrors: true,
    diagnostics: true,
    imagePull: true,
    projectBuild: true,
    containerRecreate: true,
};

export function parseFeatureFlags(raw: string | null): FeatureFlags {
    if (!raw) return { ...defaultFeatureFlags };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Configuração de funcionalidades inválida.');
    }
    const flags = { ...defaultFeatureFlags };
    for (const [key, enabled] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(flags, key) || typeof enabled !== 'boolean') {
            throw new Error('Configuração de funcionalidades inválida.');
        }
        flags[key as keyof FeatureFlags] = enabled;
    }
    return flags;
}

export function parsePreferences(raw: string | null): Preferences {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Preferências locais inválidas.');
    }
    const preferences: Preferences = {};
    for (const [path, preference] of Object.entries(value)) {
        if (!isRecord(preference) || typeof preference.favorite !== 'boolean'
            || typeof preference.group !== 'string'
            || (preference.alias !== undefined && typeof preference.alias !== 'string')
            || (preference.aliasPosition !== undefined
                && preference.aliasPosition !== 'prefix' && preference.aliasPosition !== 'suffix')) {
            throw new Error('Apelidos, favoritos ou grupos locais inválidos.');
        }
        preferences[path] = {
            favorite: preference.favorite,
            group: preference.group,
            alias: typeof preference.alias === 'string' ? preference.alias.trim() : '',
            aliasPosition: preference.aliasPosition === 'suffix' ? 'suffix' : 'prefix',
        };
    }
    return preferences;
}

export function projectDisplayName(name: string, alias: string, position: ProjectAliasPosition): string {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) return name;
    return position === 'prefix' ? `${trimmedAlias} · ${name}` : `${name} · ${trimmedAlias}`;
}

export function parseServiceNames(raw: string | null): ServiceNames {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error('Nomes personalizados de serviços inválidos.');
    const names: ServiceNames = {};
    for (const [path, services] of Object.entries(value)) {
        if (!isRecord(services)) {
            throw new Error('Nomes personalizados de serviços inválidos.');
        }
        const serviceNames: Record<string, string> = {};
        for (const [service, name] of Object.entries(services)) {
            if (typeof name !== 'string') throw new Error('Nomes personalizados de serviços inválidos.');
            if (name.trim()) serviceNames[service] = name.trim();
        }
        names[path] = serviceNames;
    }
    return names;
}

export function serviceDisplayName(names: ServiceNames, path: string, service: string): string {
    return names[path]?.[service] || service;
}

export function parseProjectComposeOptions(raw: string | null): ProjectComposeOptionsMap {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Opções Compose locais inválidas.');
    }
    const options: ProjectComposeOptionsMap = {};
    for (const [path, option] of Object.entries(value)) {
        if (!isRecord(option) || !isStringArray(option.profiles)
            || !('envFile' in option) || (option.envFile !== null && typeof option.envFile !== 'string')) {
            throw new Error('Opções Compose locais inválidas.');
        }
        options[path] = { profiles: [...option.profiles], envFile: option.envFile as string | null };
    }
    return options;
}

export function parseServicePresets(raw: string | null): ServicePresets {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Predefinições de serviços inválidas.');
    }
    const presets: ServicePresets = {};
    for (const [path, entries] of Object.entries(value)) {
        if (!Array.isArray(entries)) {
            throw new Error('Predefinições de serviços inválidas.');
        }
        presets[path] = entries.map(entry => {
            if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()
                || !isStringArray(entry.services) || !entry.services.length) {
                throw new Error('Predefinições de serviços inválidas.');
            }
            return { name: entry.name, services: [...entry.services] };
        });
    }
    return presets;
}

export function parseTerminalCommandPresets(raw: string | null): TerminalCommandPresets {
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error('Predefinições de comandos inválidas.');
    const presets: TerminalCommandPresets = {};
    for (const [key, entries] of Object.entries(value)) {
        if (!key || !Array.isArray(entries)) {
            throw new Error('Predefinições de comandos inválidas.');
        }
        presets[key] = entries.map(entry => {
            if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()
                || typeof entry.command !== 'string' || !entry.command.trim()) {
                throw new Error('Predefinições de comandos inválidas.');
            }
            if (entry.autoExecute !== undefined && typeof entry.autoExecute !== 'boolean') {
                throw new Error('Predefinições de comandos inválidas.');
            }
            return {
                name: entry.name.trim(),
                command: entry.command.trim(),
                autoExecute: entry.autoExecute === true,
            };
        });
    }
    return presets;
}

export const serviceFailed = (service: ComposeService) =>
    service.health === 'unhealthy' || service.state === 'dead';

export function projectMatches(
    project: Project,
    query: string,
    status: StatusFilter,
    displayNames: Record<string, string> = {},
    displayProjectName = project.name,
): boolean {
    const term = query.trim().toLocaleLowerCase();
    const matchesText = !term || [
        project.name,
        displayProjectName,
        project.path,
        ...project.services.flatMap(service => [service.name, service.image, displayNames[service.name] ?? '']),
    ]
        .some(value => value.toLocaleLowerCase().includes(term));
    if (!matchesText) return false;
    if (status === 'failed' && project.error) return true;
    if (status !== 'all') return servicesForFilter(project, query, status, displayNames, displayProjectName).length > 0
        || (status === 'stopped' && !project.error && !isProjectActive(project) && project.services.length === 0);
    return true;
}

export function servicesForFilter(
    project: Project,
    query: string,
    status: StatusFilter,
    displayNames: Record<string, string> = {},
    displayProjectName = project.name,
): ComposeService[] {
    const term = query.trim().toLocaleLowerCase();
    const projectNameMatches = [project.name, displayProjectName, project.path]
        .some(value => value.toLocaleLowerCase().includes(term));
    return project.services.filter(service => {
        if (!projectNameMatches && ![service.name, service.image, displayNames[service.name] ?? '']
            .some(value => value.toLocaleLowerCase().includes(term))) return false;
        if (status === 'active') return isServiceActive(service);
        if (status === 'stopped') return !isServiceActive(service);
        if (status === 'failed') return serviceFailed(service);
        return true;
    });
}

export function sortServices(services: ComposeService[], sort: ServiceSort): ComposeService[] {
    return [...services].sort((a, b) => {
        if (sort === 'active') {
            const activeDifference = Number(isServiceActive(b)) - Number(isServiceActive(a));
            if (activeDifference !== 0) return activeDifference;
        } else if (sort === 'state') {
            const stateDifference = a.state.localeCompare(b.state);
            if (stateDifference !== 0) return stateDifference;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

export function portAddress(port: ServicePort): string {
    const host = ['', '0.0.0.0', '::'].includes(port.host_ip) ? 'localhost' : port.host_ip;
    return `${host.includes(':') ? `[${host}]` : host}:${port.published}`;
}

export const isLogError = (line: string) =>
    /\b(?:error|err|fail(?:ed|ure)?|fatal|panic|exception|critical|crit|timeout|timed out|refused|denied|unavailable|abort(?:ed)?)\b|(?<![\p{L}\p{N}_])(?:erro|falha|exce[cç][aã]o|recusad[oa]s?|indispon[ií]vel|esgotou o tempo)(?![\p{L}\p{N}_])/iu.test(line);

export function filterLogLines(lines: string[], query: string, errorsOnly: boolean): string[] {
    const term = query.trim().toLocaleLowerCase();
    return lines.filter(line => (!term || line.toLocaleLowerCase().includes(term)) && (!errorsOnly || isLogError(line)));
}
