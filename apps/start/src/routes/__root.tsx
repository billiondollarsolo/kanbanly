import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { themeBootScript } from "@kanbanly/core";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "kanbanly · TanStack Start" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    scripts: [
      {
        children: themeBootScript(),
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-theme-pref="system">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
