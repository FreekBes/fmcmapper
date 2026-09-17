import { describe, test, expect, afterEach } from 'vitest';
import { parseList, parsePos, parseDimension, playersEnabled } from '../src/players';

describe('parseList — the `list` command reply', () => {
  test('extracts names after "online:"', () => {
    expect(parseList('There are 2 of a max of 20 players online: Alice, Bob')).toEqual(['Alice', 'Bob']);
  });

  test('handles a single player', () => {
    expect(parseList('There are 1 of a max of 20 players online: Steve')).toEqual(['Steve']);
  });

  test('empty when nobody is online', () => {
    expect(parseList('There are 0 of a max of 20 players online:')).toEqual([]);
  });

  test('trims whitespace and drops empties', () => {
    expect(parseList('online:  Alice ,  Bob ,')).toEqual(['Alice', 'Bob']);
  });

  test('empty for an unrecognised reply', () => {
    expect(parseList('Unknown command')).toEqual([]);
  });
});

describe('parsePos — the `Pos` entity-data reply', () => {
  test('reads x/y/z, ignoring the d/f NBT suffixes', () => {
    expect(parsePos('Alice has the following entity data: [123.5d, 64.0d, -42.3d]'))
      .toEqual([123.5, 64, -42.3]);
    expect(parsePos('[1.5f, 2f, 3f]')).toEqual([1.5, 2, 3]);
  });

  test('null when there is no coordinate list', () => {
    expect(parsePos('Alice has no entity data')).toBeNull();
  });

  test('null when fewer than three components', () => {
    expect(parsePos('[1.0d, 2.0d]')).toBeNull();
  });

  test('null when a component is not a number', () => {
    expect(parsePos('[abc, 1.0d, 2.0d]')).toBeNull();
  });
});

describe('parseDimension — the `Dimension` entity-data reply', () => {
  test('reads the quoted resource location', () => {
    expect(parseDimension('Alice has the following entity data: "minecraft:the_nether"'))
      .toBe('minecraft:the_nether');
  });

  test('null when unquoted / unreadable', () => {
    expect(parseDimension('no dimension here')).toBeNull();
  });
});

describe('playersEnabled — opt-in on RCON host + port', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  test('true only when both RCON_HOST and RCON_PORT are set', () => {
    delete process.env.RCON_HOST; delete process.env.RCON_PORT;
    expect(playersEnabled()).toBe(false);
    process.env.RCON_HOST = 'localhost';
    expect(playersEnabled()).toBe(false); // port still missing
    process.env.RCON_PORT = '25575';
    expect(playersEnabled()).toBe(true);
  });
});
