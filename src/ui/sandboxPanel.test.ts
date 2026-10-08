import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountSandboxPanel, type SandboxCommand, type SandboxSnapshot } from "./sandboxPanel";

const snapshot = (over: Partial<SandboxSnapshot> = {}): SandboxSnapshot => ({
  editing: true,
  activeCarId: 2,
  carIds: [1, 2, 3],
  raceLaps: 5,
  car: { cellId: "Z20_L1_00", lapCount: 1, tire: 80.4, fuel: 55, compound: "soft", budgetLeft: 40, isBot: true, botLevel: "hard" },
  ...over
});

const send = (s: SandboxSnapshot) => window.dispatchEvent(new CustomEvent("srp:sandbox", { detail: s }));

describe("sandbox panel", () => {
  let panel: HTMLElement;
  let commands: SandboxCommand[];
  const onCommand = (e: Event) => commands.push((e as CustomEvent<SandboxCommand>).detail);
  const el = <T extends HTMLElement>(id: string) => panel.querySelector<T>(`[data-testid="${id}"]`)!;
  const change = (id: string, value: string) => {
    const input = el<HTMLInputElement>(id);
    input.value = value;
    input.dispatchEvent(new Event("change"));
  };

  beforeEach(() => {
    commands = [];
    document.body.replaceChildren();
    panel = mountSandboxPanel(document.body);
    window.addEventListener("srp:sandbox-command", onCommand);
  });
  afterEach(() => window.removeEventListener("srp:sandbox-command", onCommand));

  it("stays hidden until a race sends a snapshot, then shows the active car", () => {
    expect(panel.hidden).toBe(true);
    send(snapshot());
    expect(panel.hidden).toBe(false);
    expect(el<HTMLSelectElement>("sandbox-car").value).toBe("2");
    expect(el<HTMLInputElement>("sandbox-cell").value).toBe("Z20_L1_00");
    expect(el<HTMLSelectElement>("sandbox-driver").value).toBe("hard");
    expect(el<HTMLInputElement>("sandbox-tire").value).toBe("80");
    expect(el("sandbox-mode").textContent).toBe("Play (E)");
    expect(el<HTMLFieldSetElement>("sandbox-fields").disabled).toBe(false);
  });

  it("locks the fields while playing", () => {
    send(snapshot({ editing: false }));
    expect(el("sandbox-mode").textContent).toBe("Edit (E)");
    expect(el<HTMLFieldSetElement>("sandbox-fields").disabled).toBe(true);
  });

  it("sends an edit for the active car", () => {
    send(snapshot());
    change("sandbox-cell", " Z23_L2_00 ");
    change("sandbox-tire", "10");
    change("sandbox-budget", "3");
    change("sandbox-compound", "hard");
    change("sandbox-driver", "human");
    change("sandbox-driver", "easy");
    change("sandbox-lap", "abc"); // not a number: nothing sent
    expect(commands).toEqual([
      { type: "edit", carId: 2, edit: { cellId: "Z23_L2_00" } },
      { type: "edit", carId: 2, edit: { tire: 10 } },
      { type: "edit", carId: 2, edit: { budgetLeft: 3 } },
      { type: "edit", carId: 2, edit: { compound: "hard" } },
      { type: "edit", carId: 2, edit: { isBot: false } },
      { type: "edit", carId: 2, edit: { isBot: true, botLevel: "easy" } }
    ]);
  });

  it("sends select, mode, copy and load commands", () => {
    send(snapshot());
    change("sandbox-car", "3");
    el("sandbox-mode").click();
    el("sandbox-copy-test").click();
    el("sandbox-copy-link").click();
    el<HTMLTextAreaElement>("sandbox-load-text").value = '{"cars":[]}';
    el("sandbox-load").click();
    expect(commands).toEqual([
      { type: "select", carId: 3 },
      { type: "mode", editing: false },
      { type: "copy-test" },
      { type: "copy-link" },
      { type: "load", text: '{"cars":[]}' }
    ]);
  });

  it("does not overwrite a field while it is being typed in", () => {
    send(snapshot());
    const cell = el<HTMLInputElement>("sandbox-cell");
    cell.focus();
    cell.value = "Z2";
    send(snapshot());
    expect(cell.value).toBe("Z2");
    cell.blur();
    send(snapshot());
    expect(cell.value).toBe("Z20_L1_00");
  });
});
