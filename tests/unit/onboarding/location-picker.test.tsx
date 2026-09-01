/**
 * JOB-313 chip picker autocomplete for target locations.
 *
 * Exercises the acceptance criteria from the ticket directly against
 * LocationPicker: typing filters suggestions, clicking a suggestion adds a
 * chip and closes the dropdown, a free entry not on the curated list still
 * adds on enter, a legacy comma joined value normalizes into separate
 * chips on load, and the 20 entry cap is enforced with a hint.
 */

import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocationPicker } from "@/components/onboarding/location-picker";

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return <LocationPicker id="targets" value={value} onChange={setValue} />;
}

function selectedChips() {
  return within(screen.getByRole("list", { name: /selected locations/i })).getAllByRole(
    "listitem",
  );
}

describe("LocationPicker", () => {
  it("suggests matching metros when typing a prefix", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "San" } });

    const listbox = screen.getByRole("listbox", { name: /location suggestions/i });
    const options = within(listbox).getAllByRole("option").map((el) => el.textContent);

    expect(options.some((text) => text?.includes("San Francisco"))).toBe(true);
    expect(options.some((text) => text?.includes("San Diego"))).toBe(true);
    expect(options.some((text) => text?.includes("San Jose"))).toBe(true);
  });

  it("adds a chip and closes the dropdown when a suggestion is clicked", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "San Francisco" } });
    const option = screen.getByRole("option", { name: /San Francisco/i });
    fireEvent.click(option);

    expect(
      within(screen.getByRole("list", { name: /selected locations/i })).getByText(
        /San Francisco/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("adds a free entry not on the curated list when enter is pressed", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "Boise" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      within(screen.getByRole("list", { name: /selected locations/i })).getByText("Boise"),
    ).toBeInTheDocument();
  });

  it("normalizes a legacy comma joined value into separate chips on load", () => {
    render(<Harness initial={["San Francisco, New York"]} />);

    const chips = selectedChips().map((chip) => chip.textContent);
    expect(chips.some((text) => text?.includes("San Francisco"))).toBe(true);
    expect(chips.some((text) => text?.includes("New York"))).toBe(true);
    expect(chips).toHaveLength(2);
  });

  it("enforces the 20 entry cap with a hint and blocks further additions", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `Location ${index}`);
    render(<Harness initial={twenty} />);

    expect(
      screen.getByText(/reached the maximum of 20 locations/i),
    ).toBeInTheDocument();

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "One more place" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(selectedChips()).toHaveLength(20);
    expect(screen.queryByText("One more place")).not.toBeInTheDocument();
  });
});
