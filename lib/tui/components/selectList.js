'use strict';

const React = require('react');

/**
 * Build a selectable list component with arrow key navigation.
 *
 * @param {object} ink
 * @returns {{ SelectList: Function }}
 */
function createSelectListComponent(ink) {
  const { Box, Text, useInput } = ink;
  const h = React.createElement;

  function SelectList({
    items,
    title,
    hint,
    onSelect,
    onCancel,
    initialIndex = 0,
    showIndex = false,
  }) {
    const list = Array.isArray(items) ? items : [];
    const [cursor, setCursor] = React.useState(
      Math.min(Math.max(initialIndex, 0), Math.max(list.length - 1, 0))
    );

    useInput((input, key) => {
      if (key.upArrow) {
        setCursor((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.downArrow) {
        setCursor((prev) => Math.min(prev + 1, list.length - 1));
        return;
      }
      if (key.return) {
        if (typeof onSelect === 'function') {
          onSelect(list[cursor], cursor);
        }
        return;
      }
      if (key.escape || input === 'q' || input === 'b') {
        if (typeof onCancel === 'function') {
          onCancel();
        }
      }
    });

    return h(
      Box,
      { flexDirection: 'column' },
      title ? h(Text, { dimColor: true }, title) : null,
      h(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        list.map((item, idx) => {
          const active = idx === cursor;
          const prefix = active ? '> ' : '  ';
          const indexLabel = showIndex ? `${idx + 1}. ` : '';
          return h(
            Box,
            { key: item && item.key ? item.key : idx, flexDirection: 'column' },
            h(
              Text,
              { color: active ? 'cyan' : undefined },
              `${prefix}${indexLabel}${item && item.label ? item.label : String(item)}`
            ),
            item && item.description
              ? h(Text, { dimColor: true }, `  ${item.description}`)
              : null
          );
        })
      ),
      hint ? h(Text, { dimColor: true }, hint) : null
    );
  }

  return { SelectList };
}

module.exports = {
  createSelectListComponent,
};
