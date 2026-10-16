export interface ReferenceExample {
  id: string;
  label: string;
  src: string;
  box: [number, number, number, number];
  foreground: [number, number][];
  background: [number, number][];
}

/** DRENDS Seq01_Colon_Med: three views of the same porcine ex-vivo colon. */
export const REFERENCE_EXAMPLES: ReferenceExample[] = [
  {
    id: "colon-1", label: "Colon · view 1", src: "/reference-material/colon-view-1.png",
    box: [0.11, 0.04, 0.50, 0.87],
    foreground: [[0.29, 0.43], [0.26, 0.58], [0.30, 0.23], [0.20, 0.38]],
    background: [[0.53, 0.49], [0.08, 0.20], [0.37, 0.75]],
  },
  {
    id: "colon-2", label: "Colon · view 2", src: "/reference-material/colon-view-2.png",
    box: [0.19, 0.22, 0.52, 0.59],
    foreground: [[0.29, 0.40], [0.24, 0.52], [0.39, 0.31], [0.44, 0.41]],
    background: [[0.64, 0.50], [0.10, 0.20], [0.38, 0.80]],
  },
  {
    id: "colon-3", label: "Colon · view 3", src: "/reference-material/colon-view-3.png",
    box: [0.49, 0.37, 0.80, 0.88],
    foreground: [[0.62, 0.63], [0.65, 0.70], [0.56, 0.57], [0.72, 0.70]],
    background: [[0.45, 0.70], [0.84, 0.59], [0.69, 0.94], [0.70, 0.30]],
  },
];
