'use strict';

const React = require('react');

/**
 * Build shared layout components for the TUI.
 *
 * @param {object} ink
 * @returns {{ Header: Function, Footer: Function, Panel: Function }}
 */
function createFrameComponents(ink) {
  const { Box, Text } = ink;
  const h = React.createElement;

  function Header({ title, subtitle, right }) {
    return h(
      Box,
      { flexDirection: 'column', marginBottom: 1 },
      h(
        Box,
        { flexDirection: 'row', justifyContent: 'space-between' },
        h(Text, { bold: true }, title || 'scoundrel'),
        right ? h(Text, { dimColor: true }, right) : null
      ),
      subtitle ? h(Text, { dimColor: true }, subtitle) : null
    );
  }

  function Footer({ hint, status }) {
    if (!hint && !status) return null;
    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      hint ? h(Text, { dimColor: true }, hint) : null,
      status ? h(Text, { color: 'yellow' }, status) : null
    );
  }

  function Panel({ title, children, grow = true }) {
    return h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'single',
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexGrow: grow ? 1 : 0,
        width: '100%',
      },
      title ? h(Text, { bold: true }, title) : null,
      children
    );
  }

  return { Header, Footer, Panel };
}

module.exports = {
  createFrameComponents,
};
