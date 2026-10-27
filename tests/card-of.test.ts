import { describe, expect, it } from 'vitest';
import { cardOf, lastFourInDescription } from '../src/integrations/plaid-shape.js';

describe('cardOf', () => {
  it('takes the last four from the account owner label when it has one', () => {
    expect(cardOf({ account_owner: 'O. Winfrey - 0000' })).toEqual({ cardLabel: 'O. Winfrey - 0000', cardLast4: '0000' });
    expect(cardOf({ account_owner: '4417' })).toEqual({ cardLabel: '4417', cardLast4: '4417' });
  });

  it('keeps a name-only label and falls back to the description for the digits', () => {
    expect(cardOf({ account_owner: '  Oprah   Winfrey ', original_description: 'CARD 5678 TARGET' }))
      .toEqual({ cardLabel: 'Oprah Winfrey', cardLast4: '5678' });
  });

  it('is empty when the bank says nothing about the card', () => {
    expect(cardOf({ account_owner: null, original_description: 'ONLINE TRANSFER TO SAVINGS 0412' }))
      .toEqual({ cardLabel: null, cardLast4: null });
    expect(cardOf({})).toEqual({ cardLabel: null, cardLast4: null });
  });
});

describe('lastFourInDescription', () => {
  it.each([
    ['POS DEBIT TARGET T-1820 OREM UT CARD 5678', '5678'],
    ['DEBIT CARD PURCHASE XXXXXXXXXXXX1234 OLD NAVY', '1234'],
    ['PURCHASE AUTHORIZED ON 10/23 COSTCO LEHI UT S386296 CARD 9012', '9012'],
    ['CHECKCARD 1023 AMAZON CRD 4410', '4410'],
    ['RECURRING PAYMENT CARD ENDING IN 7788', '7788'],
    ['NETFLIX.COM ****3344', '3344'],
  ])('finds the card in %s', (text, expected) => {
    expect(lastFourInDescription(text)).toBe(expected);
  });

  it.each([
    'TARGET STORE #1820 OREM UT',
    'ACH DEPOSIT PAYROLL 20261023',
    'ZELLE PAYMENT TO JANE 1234567',
    '',
  ])('finds no card in %s', (text) => {
    expect(lastFourInDescription(text)).toBeNull();
  });
});
