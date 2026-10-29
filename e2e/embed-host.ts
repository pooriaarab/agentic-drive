// The script of the host page in embed.spec.ts. It imports the built package file, as an app does.
import { mount, type MountedDrive } from "../dist/embed.js";

let mounted: MountedDrive | undefined;
Object.assign(window, {
  start: (token: string) => (mounted = mount(document.getElementById("drive")!, { baseUrl: location.origin, getToken: () => token })),
  stop: () => mounted?.unmount(),
});
