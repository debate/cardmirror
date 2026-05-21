import { describe, expect, it } from 'vitest';
import { schema, newHeadingId, bookmarkNameForId, idFromBookmarkName } from '../../src/schema/index.js';

describe('schema', () => {
  it('constructs without error', () => {
    expect(schema).toBeDefined();
    for (const name of [
      'doc', 'pocket', 'hat', 'block', 'tag', 'analytic', 'undertag',
      'cite_paragraph', 'card', 'card_body', 'paragraph', 'image',
    ]) {
      expect(schema.nodes[name], `node "${name}" should be defined`).toBeDefined();
    }
  });

  it('exposes all named-style emphasis marks', () => {
    for (const name of ['cite_mark', 'underline_mark', 'emphasis_mark', 'undertag_mark', 'analytic_mark']) {
      expect(schema.marks[name], `mark "${name}" should be defined`).toBeDefined();
    }
  });

  it('exposes all direct-formatting marks', () => {
    for (const name of ['bold', 'italic', 'link', 'highlight', 'font_color', 'font_size', 'font_family', 'shading']) {
      expect(schema.marks[name], `mark "${name}" should be defined`).toBeDefined();
    }
  });
});

describe('heading ID utilities', () => {
  it('newHeadingId produces a UUID', () => {
    const id = newHeadingId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('newHeadingId produces unique values', () => {
    const a = newHeadingId();
    const b = newHeadingId();
    expect(a).not.toBe(b);
  });

  it('bookmarkNameForId / idFromBookmarkName are inverses', () => {
    const id = newHeadingId();
    const bookmark = bookmarkNameForId(id);
    expect(bookmark).toMatch(/^pmd-heading-/);
    expect(idFromBookmarkName(bookmark)).toBe(id);
  });

  it('idFromBookmarkName returns null for non-pmd bookmarks', () => {
    expect(idFromBookmarkName('_GoBack')).toBe(null);
    expect(idFromBookmarkName('SomeOtherBookmark')).toBe(null);
  });
});

describe('node construction', () => {
  it('builds a flat doc with heading paragraphs and a card', () => {
    // Hierarchy is implicit in doc order, not schema containment.
    const docNode = schema.nodes['doc']!.createAndFill(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Pocket title')),
      schema.nodes['hat']!.create({ id: newHeadingId() }, schema.text('Hat title')),
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block title')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag text')),
        schema.nodes['cite_paragraph']!.create(null, schema.text('Author 2024, Source')),
        schema.nodes['card_body']!.create(null, schema.text('Card body text.')),
      ]),
    ]);
    expect(docNode).not.toBeNull();
    expect(docNode!.childCount).toBe(4);
    expect(docNode!.child(0).type.name).toBe('pocket');
    expect(docNode!.child(3).type.name).toBe('card');
  });

  it('builds a card without a cite (just tag + body)', () => {
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag-only card')),
      schema.nodes['card_body']!.create(null, schema.text('Body without cite.')),
    ]);
    expect(card.firstChild!.type.name).toBe('tag');
  });

  it('builds a card with just a tag (no body, no cite)', () => {
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Lonely tag')),
    ]);
    expect(card.childCount).toBe(1);
  });

  it('rejects a card without a tag', () => {
    expect(() => {
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['card_body']!.create(null, schema.text('No tag.')),
      ]);
    }).toThrow();
  });

  it('rejects a free-standing tag at doc level', () => {
    // Tags only appear inside cards.
    expect(() => {
      schema.nodes['doc']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Stray tag')),
      ]);
    }).toThrow();
  });

  it('allows a doc with only a loose paragraph', () => {
    const docNode = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('Just some loose text')),
    ]);
    expect(docNode.firstChild!.type.name).toBe('paragraph');
  });

  it('allows loose paragraphs alongside cards (speech-doc bridge text pattern)', () => {
    // Real use case: a Block heading followed by a card, then unstyled
    // bridge text as a plain paragraph, then another card.
    const docNode = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Card 1')),
      ]),
      schema.nodes['paragraph']!.create(null, schema.text('Bridge text')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Card 2')),
      ]),
    ]);
    expect(docNode.childCount).toBe(4);
    expect(docNode.child(2).type.name).toBe('paragraph');
  });

  it('allows a doc starting with a Block (no Pocket required, per real CP doc)', () => {
    const docNode = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text('Block')),
      schema.nodes['card']!.create(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('A tag')),
      ]),
    ]);
    expect(docNode.firstChild!.type.name).toBe('block');
  });

  it('allows multiple top-level Pockets (the multi-file pattern)', () => {
    const docNode = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('First file')),
      schema.nodes['pocket']!.create({ id: newHeadingId() }, schema.text('Second file')),
    ]);
    expect(docNode.childCount).toBe(2);
  });

  it('allows an empty Pocket (the DA→CP separator pattern)', () => {
    const empty = schema.nodes['pocket']!.createChecked({ id: newHeadingId() }, []);
    expect(empty.childCount).toBe(0);
  });

  it('rejects a Hat directly inside a Card', () => {
    expect(() => {
      schema.nodes['card']!.createChecked(null, [
        schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('A tag')),
        schema.nodes['hat']!.create({ id: newHeadingId() }, []),
      ]);
    }).toThrow();
  });

  it('standalone analytics live inside an analytic_unit (peer to card)', () => {
    const docNode = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['analytic_unit']!.create(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('A standalone analytic')),
      ]),
    ]);
    expect(docNode.firstChild!.type.name).toBe('analytic_unit');
    expect(docNode.firstChild!.firstChild!.type.name).toBe('analytic');
  });

  it('rejects a bare analytic at doc level (must be inside analytic_unit or card)', () => {
    expect(() => {
      schema.nodes['doc']!.createChecked(null, [
        schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('Stray analytic')),
      ]);
    }).toThrow();
  });

  it('allows an analytic inside a card (cite-position alternative)', () => {
    const card = schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text('Tag')),
      schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('In-card analytic')),
      schema.nodes['card_body']!.create(null, schema.text('Body')),
    ]);
    expect(card.child(1).type.name).toBe('analytic');
  });

  it('image is an inline atom that fits inside body paragraphs', () => {
    const img = schema.nodes['image']!.createChecked({
      data: 'iVBORw0KGgo=', // 1×1 PNG header bytes (truncated, fine for schema)
      contentType: 'image/png',
      widthEmu: 100000,
      heightEmu: 100000,
      alt: 'placeholder',
    });
    const body = schema.nodes['card_body']!.createChecked(null, [
      schema.text('Before '),
      img,
      schema.text(' after'),
    ]);
    expect(body.childCount).toBe(3);
    expect(body.child(1).type.name).toBe('image');
    expect(body.child(1).attrs['contentType']).toBe('image/png');
    expect(body.child(1).attrs['widthEmu']).toBe(100000);
  });

  it('analytic_unit absorbs body paragraphs', () => {
    const unit = schema.nodes['analytic_unit']!.createChecked(null, [
      schema.nodes['analytic']!.create({ id: newHeadingId() }, schema.text('Header')),
      schema.nodes['card_body']!.create(null, schema.text('Body 1')),
      schema.nodes['card_body']!.create(null, schema.text('Body 2')),
    ]);
    expect(unit.childCount).toBe(3);
  });
});

describe('marks', () => {
  it('underline_mark applies to text', () => {
    const text = schema.text('underlined', [
      schema.marks['underline_mark']!.create(),
    ]);
    expect(text.marks).toHaveLength(1);
    expect(text.marks[0]!.type.name).toBe('underline_mark');
  });

  it('highlight mark carries a color attr', () => {
    const text = schema.text('yellow stuff', [
      schema.marks['highlight']!.create({ color: 'yellow' }),
    ]);
    expect(text.marks[0]!.attrs['color']).toBe('yellow');
  });

  it('font_color mark accepts hex strings', () => {
    const text = schema.text('reference text', [
      schema.marks['font_color']!.create({ color: '555555' }),
    ]);
    expect(text.marks[0]!.attrs['color']).toBe('555555');
  });

  it('font_color round-trips via JSON', () => {
    const text = schema.text('text', [
      schema.marks['font_color']!.create({ color: 'aabbcc' }),
    ]);
    const json = text.toJSON();
    expect(json).toBeDefined();
  });

  it('font_color toDOM omits inline style for the 000000 sentinel', () => {
    const markBlack = schema.marks['font_color']!.create({ color: '000000' });
    const markColored = schema.marks['font_color']!.create({ color: 'FF0000' });
    const [, attrsBlack] = markBlack.type.spec.toDOM!(markBlack, true) as [
      string,
      Record<string, string>,
      number,
    ];
    const [, attrsColored] = markColored.type.spec.toDOM!(markColored, true) as [
      string,
      Record<string, string>,
      number,
    ];
    expect(attrsBlack['data-color']).toBe('000000');
    expect(attrsBlack['style']).toBeUndefined();
    expect(attrsColored['data-color']).toBe('FF0000');
    expect(attrsColored['style']).toBe('color: #FF0000');
  });

  it('font_color toDOM emits a luminance band for dark-mode contrast', () => {
    // Threshold check — anything below perceived-luminance 0.4 is `dark`.
    const cases: { color: string; expected: 'dark' | 'light' }[] = [
      { color: '000000', expected: 'dark' },   // pure black
      { color: '0563C1', expected: 'dark' },   // Word's hyperlink blue (~0.32)
      { color: 'FF0000', expected: 'dark' },   // pure red (~0.30)
      { color: '888888', expected: 'light' },  // mid gray (~0.53)
      { color: 'FFFFFF', expected: 'light' },  // pure white
      { color: 'FFFF00', expected: 'light' },  // bright yellow
    ];
    for (const { color, expected } of cases) {
      const mark = schema.marks['font_color']!.create({ color });
      const [, attrs] = mark.type.spec.toDOM!(mark, true) as [
        string,
        Record<string, string>,
        number,
      ];
      expect(attrs['data-color-band'], `${color} should be ${expected}`).toBe(expected);
    }
  });

  it('highlight toDOM emits a luminance band per OOXML name', () => {
    // `data-highlight-band` lets CSS pick black-vs-white text /
    // underline contrast via a single attribute check instead of
    // enumerating every OOXML highlight name in a `:has()` clause.
    const cases: { color: string; expected: 'light' | 'dark' | 'none' }[] = [
      { color: 'yellow', expected: 'light' },
      { color: 'green', expected: 'light' },
      { color: 'lightGray', expected: 'light' },
      { color: 'blue', expected: 'dark' },
      { color: 'darkGreen', expected: 'dark' },
      { color: 'black', expected: 'dark' },
      { color: 'none', expected: 'none' },
    ];
    for (const { color, expected } of cases) {
      const mark = schema.marks['highlight']!.create({ color });
      const [, attrs] = mark.type.spec.toDOM!(mark, true) as [
        string,
        Record<string, string>,
        number,
      ];
      expect(attrs['data-highlight']).toBe(color);
      expect(attrs['data-highlight-band'], `${color} should be ${expected}`).toBe(expected);
    }
  });

  it('shading toDOM emits a luminance band so CSS can pick contrast', () => {
    const lightShading = schema.marks['shading']!.create({ color: 'FFFF00' });
    const darkShading = schema.marks['shading']!.create({ color: '000080' });
    const [, lightAttrs] = lightShading.type.spec.toDOM!(lightShading, true) as [
      string,
      Record<string, string>,
      number,
    ];
    const [, darkAttrs] = darkShading.type.spec.toDOM!(darkShading, true) as [
      string,
      Record<string, string>,
      number,
    ];
    expect(lightAttrs['data-shading']).toBe('FFFF00');
    expect(lightAttrs['data-shading-band']).toBe('light');
    expect(darkAttrs['data-shading']).toBe('000080');
    expect(darkAttrs['data-shading-band']).toBe('dark');
  });

  it('font_family stores a font name', () => {
    const text = schema.text('Arial text', [
      schema.marks['font_family']!.create({ name: 'Arial' }),
    ]);
    expect(text.marks[0]!.attrs['name']).toBe('Arial');
  });

  it('font_size uses half-points like OOXML', () => {
    const text = schema.text('big', [
      schema.marks['font_size']!.create({ halfPoints: 26 }),
    ]);
    expect(text.marks[0]!.attrs['halfPoints']).toBe(26);
  });

  it('link mark stores href', () => {
    const text = schema.text('linked', [
      schema.marks['link']!.create({ href: 'https://example.com' }),
    ]);
    expect(text.marks[0]!.attrs['href']).toBe('https://example.com');
  });

  it('multiple marks compose on the same text', () => {
    const text = schema.text('emphasized highlight', [
      schema.marks['underline_mark']!.create(),
      schema.marks['highlight']!.create({ color: 'yellow' }),
      schema.marks['bold']!.create(),
    ]);
    expect(text.marks).toHaveLength(3);
  });
});
