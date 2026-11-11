import type { ReactNode } from 'react';

const paths = {
    chevron: <path d="m9 6 6 6-6 6" />,
    more: <><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></>,
    play: <path d="M8 5.5v13l11-6.5Z" />,
    stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
    restart: <><path d="M21 2v6h-6" /><path d="M21 8a9 9 0 1 0 2.64 6.36" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" /></>,
    logs: <path d="M5 6h14M5 12h14M5 18h9" />,
    terminal: <path d="m5 8 5 4-5 4M12 17h7" />,
    chart: <path d="M5 20v-8M12 20V5M19 20v-5" />,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>,
    external: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
    star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8Z" />,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
    bell: <><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15Z" /><path d="M10 21h4" /></>,
    bellOff: <><path d="M6 16v-5a6 6 0 0 1 9-5.2M18 11v5l1.5 2h-15" /><path d="M10 21h4M4 4l16 16" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.2-4.2" /></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    alert: <><path d="M12 4 2.5 20h19Z" /><path d="M12 10v4M12 17.5v.1" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16Z" /><path d="M13.5 6.5 17.5 10.5" /></>,
    sliders: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="15" cy="18" r="2" /></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6Z" /><path d="m9 12 2 2 4-4" /></>,
    cpu: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3M10 10h4v4h-4z" /></>,
    memory: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 6v12M11 6v12M15 6v12M19 6v12M7 3v3M11 3v3M15 3v3M19 3v3M7 18v3M11 18v3M15 18v3M19 18v3" /></>,
    network: <><circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="m8.6 10.5 6.8-3M8.6 13.5l6.8 3" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export default function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
    return (
        <svg
            className="icon"
            viewBox="0 0 24 24"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >{paths[name]}</svg>
    );
}
