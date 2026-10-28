import { isProjectActive, isServiceActive } from './docker.ts';
import type { ComposeService, Project, ServicePort } from './docker';

export interface ProjectPreference {
    favorite: boolean;
    group: string;
}

export type Preferences = Record<string, ProjectPreference>;
export interface ProjectComposeOptions {
    profiles: string[];
    envFile: string | null;
}
export type ProjectComposeOptionsMap = Record<string, ProjectComposeOptions>;
export interface ServicePreset {
    name: string;
    services: string[];
}
export type ServicePresets = Record<string, ServicePreset[]>;
export type StatusFilter = 'all' | 'active' | 'stopped' | 'failed';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
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
        if (!preference || typeof preference !== 'object'
            || !('favorite' in preference) || typeof preference.favorite !== 'boolean'
            || !('group' in preference) || typeof preference.group !== 'string') {
            throw new Error('Favoritos ou grupos locais inválidos.');
        }
        preferences[path] = { favorite: preference.favorite, group: preference.group };
    }
    return preferences;
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

export const serviceFailed = (service: ComposeService) =>
    service.health === 'unhealthy' || service.state === 'dead';

export function projectMatches(project: Project, query: string, status: StatusFilter): boolean {
    const term = query.trim().toLocaleLowerCase();
    const matchesText = !term || [project.name, project.path, ...project.services.flatMap(service => [service.name, service.image])]
        .some(value => value.toLocaleLowerCase().includes(term));
    if (!matchesText) return false;
    if (status === 'failed' && project.error) return true;
    if (status !== 'all') return servicesForFilter(project, query, status).length > 0
        || (status === 'stopped' && !project.error && !isProjectActive(project) && project.services.length === 0);
    return true;
}

export function servicesForFilter(project: Project, query: string, status: StatusFilter): ComposeService[] {
    const term = query.trim().toLocaleLowerCase();
    const projectNameMatches = [project.name, project.path].some(value => value.toLocaleLowerCase().includes(term));
    return project.services.filter(service => {
        if (!projectNameMatches && ![service.name, service.image].some(value => value.toLocaleLowerCase().includes(term))) return false;
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
