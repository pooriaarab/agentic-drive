// The script of the host page in embed.spec.ts. It imports the built package file, as an app does.
import { mount, type OnOpenItem, type DriveLocation, type MountedDrive } from "../dist/embed.js";

let mounted: MountedDrive | undefined;
const opened: unknown[] = [];
Object.assign(window, {
  opened,
  navigate: (next: DriveLocation) => mounted?.setLocation(next),
  active: () => mounted?.getLocation(),
  startRouter: (token: string, initial: DriveLocation) => {
    mounted = mount(document.getElementById("drive")!, {
      baseUrl: location.origin, getToken: () => token, location: initial,
      onNavigate: (next, { replace }) => {
        const url = `?drive=${encodeURIComponent(JSON.stringify(next))}`;
        if (replace) history.replaceState(next, "", url);
        else history.pushState(next, "", url);
      },
    });
    history.replaceState(initial, "");
    addEventListener("popstate", (event) => mounted?.setLocation(event.state));
  },
  setOpenHook: (token: string, handled: boolean | null) => {
    const onOpenItem: OnOpenItem | undefined = handled === null ? undefined : (item) => { opened.push(item); return handled; };
    mounted?.update({ baseUrl: location.origin, getToken: () => token, onOpenItem });
  },
  start: (token: string) => (mounted = mount(document.getElementById("drive")!, { baseUrl: location.origin, getToken: () => token })),
  stop: () => mounted?.unmount(),
});
