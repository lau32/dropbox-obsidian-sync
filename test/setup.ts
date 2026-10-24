// Source uses window.setTimeout etc. for popout-window compatibility; alias it in node.
(globalThis as { window?: unknown }).window = globalThis;
