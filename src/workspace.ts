import { isProjectActive, isServiceActive } from './docker.ts';
import type { ComposeService, Project, ServicePort } from './docker';

export interface ProjectPreference {
    favorite: boolean;
    group: string;
}

export type Preferences = Record<string, ProjectPreference>;
export type StatusFilter = 'all' | 'active' | 'stopped' | 'failed';

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

export function portAddress(port: ServicePort): string {
    const host = ['', '0.0.0.0', '::'].includes(port.host_ip) ? 'localhost' : port.host_ip;
    return `${host.includes(':') ? `[${host}]` : host}:${port.published}`;
}

export const isLogError = (line: string) => /\berror\b|\bfail(?:ed|ure)?\b|\bfatal\b|\bpanic\b|exception/i.test(line);

export function filterLogLines(lines: string[], query: string, errorsOnly: boolean): string[] {
    const term = query.trim().toLocaleLowerCase();
    return lines.filter(line => (!term || line.toLocaleLowerCase().includes(term)) && (!errorsOnly || isLogError(line)));
}
