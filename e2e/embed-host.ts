// The script of the host page in embed.spec.ts. It imports the built package file, as an app does.
import { mount, type OnOpenItem, type MountedDrive } from "../dist/embed.js";

let mounted: MountedDrive | undefined;
const opened: unknown[] = [];
Object.assign(window, {
  opened,
  setOpenHook: (token: string, handled: boolean | null) => {
    const onOpenItem: OnOpenItem | undefined = handled === null ? undefined : (item) => { opened.push(item); return handled; };
    mounted?.update({ baseUrl: location.origin, getToken: () => token, onOpenItem });
  },
  start: (token: string) => (mounted = mount(document.getElementById("drive")!, { baseUrl: location.origin, getToken: () => token })),
  stop: () => mounted?.unmount(),
});
