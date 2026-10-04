import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kontuur — Incoming calls",
    short_name: "Kontuur",
    description: "Call messages for your organization",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f6f4",
    theme_color: "#286f55",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
