"use client";
/** The Terminal workbench composition root — builds the DI container, wires surface commands,
 *  and renders the Dockview workbench inside the shared AppGates. Served at `/terminal` and
 *  `/terminal/meetings/[meetingId]` for the dev/power-user workflow. */
import {
  createContainer, reg, ServicesProvider,
  CommandServiceId, createCommandService,
  ContextKeyServiceId, createContextKeyService,
  KeybindingServiceId, createKeybindingService,
} from "../platform";
import { LayoutServiceId, createLayoutService } from "../workbench/layout";
import { PaletteServiceId, createPaletteService } from "../workbench/palette";
import { registerEngineCommands } from "../workbench/commands";
import { Workbench } from "../workbench/Workbench";
import { registry } from "../contributions";
import { AppGates } from "./AppGates";
import "../surfaces";

const container = createContainer([
  reg(ContextKeyServiceId, () => createContextKeyService()),
  reg(CommandServiceId, (c) => createCommandService(c)),
  reg(LayoutServiceId, () => createLayoutService("meetings")),
  reg(PaletteServiceId, () => createPaletteService()),
  reg(KeybindingServiceId, (c) => createKeybindingService(c)),
]);
registry.commands().forEach((c) => container.get(CommandServiceId).register(c));
registerEngineCommands(container);

export function App() {
  return (
    <AppGates>
      <ServicesProvider container={container}>
        <Workbench />
      </ServicesProvider>
    </AppGates>
  );
}
