// bb-plugin-boat frontend entry: the Boat page in bb's sidebar.
//
// Compiled by `bb plugin build` into dist/app.js + app.css. React and
// @get-bb/plugin-sdk/app come from the bb app at load time. All Boat data and
// actions go through the server's typed RPC (src/dashboard.ts); this bundle never
// sees the Boat API key or box addresses.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BoatPage, RunningCount } from "./ui/BoatPage.tsx";
import { BoatMachineInputs } from "./ui/MachineInputs.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "boat",
    title: "Boat",
    // Unknown icon names fall back to the plugin branding (boat.svg).
    icon: "Ship",
    path: "boat",
    component: BoatPage,
    experimental_sidebarAccessory: RunningCount,
  });
  // T17: fork source / size when "Boat sandbox" is picked for a new thread.
  app.slots.experimental_machineProviderInputs({ machineProviderId: "boat", component: BoatMachineInputs });
});
