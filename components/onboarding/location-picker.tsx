"use client";

/**
 * JOB-313: chip picker autocomplete for step 3 target locations.
 *
 * Replaces the old comma separated free text input. The underlying data
 * shape stays `string[]`, unchanged from `step3Schema.targetLocations` in
 * `lib/onboarding/intake-schema.ts`, so nothing downstream of this component
 * has to change.
 *
 * Suggestions come from the static, hardcoded list in
 * `data/location-suggestions.ts`. Typing a name not on that list and
 * pressing enter still adds it as a chip. This keeps the picker useful for
 * a candidate targeting a place a curated list of 71 cities cannot cover,
 * while still cutting the format errors a free text comma list produced for
 * everyone else.
 *
 * Accessibility follows the WAI ARIA combobox pattern: the text input carries
 * role="combobox" and aria-activedescendant, the suggestion list carries
 * role="listbox", and each suggestion is role="option". The chip count below
 * the picker is an aria live region, so adding or removing a chip near the
 * cap gets announced without a screen reader having to find it. This was not
 * verified against a live screen reader in this environment; see the PR
 * description for what was and was not checked.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { LOCATION_SUGGESTIONS } from "@/data/location-suggestions";

/** How many matches to show at once. The full list is 71 entries long. */
const MAX_VISIBLE_SUGGESTIONS = 8;

/**
 * Splits a stored value on commas defensively, so a profile saved before
 * this picker existed (or any row where a single array entry still holds a
 * raw comma separated string) loads into distinct chips instead of one
 * chip with a comma baked into it.
 */
function normalizeInitialValue(value: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    for (const piece of entry.split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

export function LocationPicker({
  id,
  value,
  onChange,
  max = 20,
  placeholder = "Search a city, or type your own",
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const didNormalize = useRef(false);
  // Selecting a chip refocuses the input so the person can keep adding, but
  // that focus event should not itself reopen the dropdown, or "click a
  // suggestion closes the dropdown" would only hold for an instant.
  const suppressNextFocusOpen = useRef(false);

  // Runs once, on mount, so an existing profile's saved locations become
  // chips even if a legacy row stored them as one comma joined string.
  useEffect(() => {
    if (didNormalize.current) return;
    didNormalize.current = true;
    const normalized = normalizeInitialValue(value);
    const changed =
      normalized.length !== value.length ||
      normalized.some((entry, index) => entry !== value[index]);
    if (changed) onChange(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const atCap = value.length >= max;

  const filteredSuggestions = useMemo(() => {
    if (atCap) return [];
    const query = inputValue.trim().toLowerCase();
    const selected = new Set(value.map((entry) => entry.toLowerCase()));
    return LOCATION_SUGGESTIONS.filter(
      (location) => !selected.has(location.toLowerCase()),
    )
      .filter((location) => query === "" || location.toLowerCase().includes(query))
      .slice(0, MAX_VISIBLE_SUGGESTIONS);
  }, [inputValue, value, atCap]);

  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  function addLocation(raw: string) {
    const normalized = raw.trim();
    if (!normalized || atCap) return;
    const exists = value.some(
      (entry) => entry.toLowerCase() === normalized.toLowerCase(),
    );
    if (!exists) onChange([...value, normalized]);
    setInputValue("");
    setHighlightedIndex(-1);
    setOpen(false);
    suppressNextFocusOpen.current = true;
    inputRef.current?.focus();
  }

  function removeLocation(location: string) {
    onChange(value.filter((entry) => entry !== location));
    suppressNextFocusOpen.current = true;
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!filteredSuggestions.length) return;
      setOpen(true);
      setHighlightedIndex((previous) =>
        previous < filteredSuggestions.length - 1 ? previous + 1 : 0,
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!filteredSuggestions.length) return;
      setOpen(true);
      setHighlightedIndex((previous) =>
        previous > 0 ? previous - 1 : filteredSuggestions.length - 1,
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (highlightedIndex >= 0 && filteredSuggestions[highlightedIndex]) {
        addLocation(filteredSuggestions[highlightedIndex]);
      } else if (inputValue.trim()) {
        addLocation(inputValue);
      }
      return;
    }

    if (event.key === ",") {
      event.preventDefault();
      if (inputValue.trim()) addLocation(inputValue);
      return;
    }

    if (event.key === "Escape") {
      setOpen(false);
      setHighlightedIndex(-1);
      return;
    }

    if (event.key === "Backspace" && inputValue === "" && value.length > 0) {
      removeLocation(value[value.length - 1]);
    }
  }

  const showDropdown = open && !atCap && filteredSuggestions.length > 0;

  return (
    <div className="space-y-2" ref={wrapperRef}>
      <div
        className={cn(
          "flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected locations">
          {value.map((location) => (
            <li key={location}>
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary py-1 pl-3 pr-1 text-sm text-secondary-foreground">
                {location}
                <button
                  type="button"
                  onClick={() => removeLocation(location)}
                  aria-label={`Remove ${location}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-secondary-foreground/70 hover:bg-secondary-foreground/10 hover:text-secondary-foreground"
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              </span>
            </li>
          ))}
        </ul>

        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined
          }
          value={inputValue}
          readOnly={atCap}
          onChange={(event) => {
            setInputValue(event.target.value);
            setOpen(true);
            setHighlightedIndex(-1);
          }}
          onFocus={() => {
            if (suppressNextFocusOpen.current) {
              suppressNextFocusOpen.current = false;
              return;
            }
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder={atCap ? "Maximum reached" : placeholder}
          className="min-w-32 flex-1 border-0 bg-transparent py-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
          autoComplete="off"
        />
      </div>

      {showDropdown ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Location suggestions"
          className="max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filteredSuggestions.map((location, index) => (
            <li
              key={location}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlightedIndex}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => addLocation(location)}
              className={cn(
                "cursor-pointer rounded-md px-3 py-2.5 text-sm",
                index === highlightedIndex
                  ? "bg-accent text-accent-foreground"
                  : "",
              )}
            >
              {location}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {atCap
          ? `You have reached the maximum of ${max} locations. Remove one to add another.`
          : `${value.length} of ${max} locations added.`}
      </p>
    </div>
  );
}
