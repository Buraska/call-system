import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kontuur — входящие звонки",
    short_name: "Kontuur",
    description: "Сообщения по звонкам для вашей организации",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f6f4",
    theme_color: "#286f55",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
