import { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Labertaschi",
    short_name: "Labertaschi",
    description: "Voice-to-Polish MVP mit Deepgram & Gemini",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#F5F5F7",
    theme_color: "#2563EB",
    icons: [
      { src: "/favicon.ico", sizes: "32x32", type: "image/x-icon" },
      { src: "/vercel.svg", sizes: "192x192", type: "image/svg+xml" },
    ],
  };
}

