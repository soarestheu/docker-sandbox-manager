import type { ReactNode } from 'react';

const paths = {
    chevron: <path d="m9 6 6 6-6 6" />,
    more: <><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></>,
    play: <path d="M8 5.5v13l11-6.5Z" />,
    stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
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
