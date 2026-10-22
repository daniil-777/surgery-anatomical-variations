// Generated SVG thumbnails for the gallery (no binary assets, no network): soft procedural "tissue" studies.

function svg(body: string, background: string): string {
  const markup = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160'>${background}${body}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

const grad = (id: string, stops: Array<[number, string]>, cx = 0.5, cy = 0.45, r = 0.75) =>
  `<radialGradient id='${id}' cx='${cx}' cy='${cy}' r='${r}'>${stops.map(([offset, color]) => `<stop offset='${offset}' stop-color='${color}'/>`).join("")}</radialGradient>`;

export const THUMBS = {
  liver: svg(
    `<defs>${grad("a", [[0, "#C2554A"], [0.55, "#8E2F2B"], [1, "#4A1517"]], 0.38, 0.35)}${grad("h", [[0, "rgba(255,255,255,.55)"], [1, "rgba(255,255,255,0)"]], 0.32, 0.28, 0.22)}</defs>
     <rect width='160' height='160' fill='url(#a)'/>
     <path d='M0 92 C40 78 70 104 110 88 S150 70 160 80 V160 H0Z' fill='rgba(60,10,12,.35)'/>
     <ellipse cx='52' cy='46' rx='34' ry='18' fill='url(#h)'/>`,
    "",
  ),
  mucosa: svg(
    `<defs>${grad("a", [[0, "#F2A7A0"], [0.6, "#D9706A"], [1, "#9C3B3F"]], 0.5, 0.5, 0.8)}</defs>
     <rect width='160' height='160' fill='url(#a)'/>
     ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<path d='M-10 ${18 + i * 22} C30 ${6 + i * 22} 60 ${34 + i * 22} 100 ${16 + i * 22} S150 ${10 + i * 22} 170 ${22 + i * 22}' stroke='rgba(120,30,40,.28)' stroke-width='5' fill='none'/>`).join("")}
     <ellipse cx='60' cy='50' rx='28' ry='12' fill='rgba(255,255,255,.25)'/>`,
    "",
  ),
  gallbladder: svg(
    `<defs>${grad("a", [[0, "#B9C46A"], [0.6, "#6E7F2E"], [1, "#33400F"]], 0.42, 0.38)}</defs>
     <rect width='160' height='160' fill='#1D2226'/>
     <path d='M42 40 C70 20 120 34 122 72 C124 112 92 136 66 128 C36 118 22 64 42 40Z' fill='url(#a)'/>
     <ellipse cx='70' cy='56' rx='16' ry='8' fill='rgba(255,255,255,.35)'/>`,
    "",
  ),
  kidney: svg(
    `<defs>${grad("a", [[0, "#B04B5A"], [0.65, "#6F1E2C"], [1, "#3B0E17"]], 0.4, 0.35)}</defs>
     <rect width='160' height='160' fill='#E9E7EA'/>
     <path d='M58 30 C96 18 128 46 124 84 C120 120 88 138 62 128 C40 120 52 98 66 92 C78 86 76 70 60 66 C40 60 30 40 58 30Z' fill='url(#a)'/>
     <ellipse cx='88' cy='54' rx='14' ry='7' fill='rgba(255,255,255,.35)'/>`,
    "",
  ),
  contact: svg(
    `<rect width='160' height='160' fill='#101418'/>
     ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<path d='M0 ${30 + i * 14} Q80 ${10 + i * 18} 160 ${34 + i * 12}' stroke='rgba(92,184,255,${0.15 + i * 0.07})' stroke-width='1.2' fill='none'/>`).join("")}
     <circle cx='96' cy='76' r='9' fill='#5CB8FF'/><circle cx='96' cy='76' r='20' fill='none' stroke='rgba(92,184,255,.35)' stroke-width='2'/>`,
    "",
  ),
  fat: svg(
    `<rect width='160' height='160' fill='#E8C35A'/>
     ${[[30, 34, 22], [76, 28, 20], [124, 40, 24], [44, 84, 26], [100, 88, 22], [140, 104, 18], [24, 132, 20], [72, 136, 22], [122, 140, 20]].map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='#F6DC8C' stroke='#C99A2E' stroke-width='2'/>`).join("")}`,
    "",
  ),
  vessels: svg(
    `<rect width='160' height='160' fill='#24161A'/>
     <path d='M80 160 V100 M80 100 C60 80 40 70 22 40 M80 100 C96 76 120 66 138 34 M50 74 C44 60 52 44 46 22 M110 70 C120 56 112 40 120 18' stroke='#E0443E' stroke-width='5' stroke-linecap='round' fill='none'/>
     <path d='M80 160 V100 M80 100 C60 80 40 70 22 40 M80 100 C96 76 120 66 138 34' stroke='rgba(255,180,170,.45)' stroke-width='1.5' fill='none'/>`,
    "",
  ),
  stomach: svg(
    `<defs>${grad("a", [[0, "#F0B3B6"], [0.6, "#D47A86"], [1, "#8F3A4E"]], 0.45, 0.4)}</defs>
     <rect width='160' height='160' fill='#F4EEF0'/>
     <path d='M50 26 C70 18 84 30 82 48 C80 64 96 70 116 70 C140 72 146 104 128 124 C106 146 56 142 42 112 C30 86 40 60 46 46 C48 38 46 30 50 26Z' fill='url(#a)'/>`,
    "",
  ),
} as const;

export type ThumbName = keyof typeof THUMBS;
