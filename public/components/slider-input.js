{
  const style = /* css */ `
    slider-input {
      display: flex;
      align-items: center;
      gap: .4em;
    }
  `;

  const styleElement = document.createElement("style");
  styleElement.setAttribute("type", "text/css");
  styleElement.innerHTML = style;
  document.head.appendChild(styleElement);
}

{
  const template = document.createElement("template");
  template.innerHTML = /* html */ `
    <input type="range" />
    <input type="number" />
  `;

  class SliderInput extends HTMLElement {
    constructor() {
      super();
      this.ensureControls();
    }

    ensureControls() {
      let range = this.querySelector("input[type=range]");
      let number = this.querySelector("input[type=number]");
      const currentValue = number?.value || range?.value || this.getAttribute("value") || 50;

      // A restored / interrupted document can occasionally leave an upgraded
      // custom element without one of its light-DOM inputs. Rebuild both controls
      // instead of letting a later generation read throw on a missing child.
      if (!range || !number) {
        this.replaceChildren(template.content.cloneNode(true));
        range = this.querySelector("input[type=range]");
        number = this.querySelector("input[type=number]");
      }

      range.value = number.value = currentValue;
      range.min = number.min = this.getAttribute("min") || 0;
      range.max = number.max = this.getAttribute("max") || 100;
      range.step = number.step = this.getAttribute("step") || 1;

      if (range.dataset.sliderInputBound !== "1") {
        range.dataset.sliderInputBound = number.dataset.sliderInputBound = "1";
        range.addEventListener("input", this.handleEvent.bind(this));
        number.addEventListener("input", this.handleEvent.bind(this));
        range.addEventListener("change", this.handleEvent.bind(this));
        number.addEventListener("change", this.handleEvent.bind(this));
      }

      return {range, number};
    }

    handleEvent(e) {
      const value = e.target.value;
      const isNaN = Number.isNaN(Number(value));
      if (isNaN || value === "") return e.stopPropagation();

      const {range, number} = this.ensureControls();
      this.value = range.value = number.value = value;

      this.dispatchEvent(
        new CustomEvent(e.type, {
          detail: {value},
          bubbles: true,
          composed: true
        })
      );
    }

    set value(value) {
      const {range, number} = this.ensureControls();
      range.value = number.value = value;
    }

    get value() {
      const {number} = this.ensureControls();
      return number.value;
    }

    get valueAsNumber() {
      const {number} = this.ensureControls();
      return number.valueAsNumber;
    }
  }

  customElements.define("slider-input", SliderInput);
}
