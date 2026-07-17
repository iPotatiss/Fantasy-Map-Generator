import { describe, expect, it } from "vitest";
import sliderInputSource from "../public/components/slider-input.js?raw";

class FakeInput {
  private storedValue = "";
  min = "";
  max = "";
  step = "";
  dataset: Record<string, string> = {};

  constructor(
    readonly type: "range" | "number",
    private readonly removeSelf: (input: FakeInput) => void
  ) {}

  set value(value: string | number) {
    this.storedValue = String(value);
  }

  get value() {
    return this.storedValue;
  }

  get valueAsNumber() {
    return Number(this.storedValue);
  }

  addEventListener() {}
  remove() {
    this.removeSelf(this);
  }
}

class FakeHTMLElement {
  private attributes = new Map<string, string>();
  private inputs: FakeInput[] = [];

  appendChild(node: { kind?: string }) {
    if (node.kind === "slider-controls") this.createInputs();
    return node;
  }

  replaceChildren(node: { kind?: string }) {
    this.inputs = [];
    if (node.kind === "slider-controls") this.createInputs();
  }

  querySelector(selector: string) {
    const type = selector.includes("range") ? "range" : "number";
    return this.inputs.find(input => input.type === type) ?? null;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  dispatchEvent() {
    return true;
  }

  private createInputs() {
    const remove = (input: FakeInput) => {
      this.inputs = this.inputs.filter(candidate => candidate !== input);
    };
    this.inputs = [new FakeInput("range", remove), new FakeInput("number", remove)];
  }
}

describe("slider-input", () => {
  it("repairs a missing numeric control instead of throwing", () => {
    let SliderInput: (new () => FakeHTMLElement & { value: string; valueAsNumber: number }) | undefined;
    const template = {
      content: { cloneNode: () => ({ kind: "slider-controls" }) },
      set innerHTML(_value: string) {}
    };
    const document = {
      head: { appendChild: () => undefined },
      createElement: (tag: string) =>
        tag === "template" ? template : { setAttribute: () => undefined, set innerHTML(_value: string) {} }
    };
    const customElements = {
      define: (_name: string, elementClass: typeof SliderInput) => {
        SliderInput = elementClass;
      }
    };
    class FakeCustomEvent {}

    new Function("document", "HTMLElement", "customElements", "CustomEvent", sliderInputSource)(
      document,
      FakeHTMLElement,
      customElements,
      FakeCustomEvent
    );

    if (!SliderInput) throw new Error("slider-input was not registered");
    const slider = new SliderInput();
    slider.value = "27";
    slider.querySelector('input[type="number"]')?.remove();

    expect(() => slider.value).not.toThrow();
    expect(slider.value).toBe("27");
    expect(slider.valueAsNumber).toBe(27);
    expect(slider.querySelector('input[type="number"]')).not.toBeNull();
  });
});
