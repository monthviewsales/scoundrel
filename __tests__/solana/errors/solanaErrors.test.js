'use strict';

const {
  classifySolanaError,
  shouldRetryRpcError,
} = require('../../../lib/solana/errors');

describe('solana error taxonomy', () => {
  test('classifies simulation failure via message', () => {
    const err = new Error('Transaction simulation failed');
    const summary = classifySolanaError(err);
    expect(summary.kind).toBe('simulation_failed');
    expect(summary.userMessage).toMatch(/simulation failed/i);
  });

  test('classifies instruction error payloads', () => {
    const err = { InstructionError: [0, { Custom: 1 }] };
    const summary = classifySolanaError(err);
    expect(summary.kind).toBe('instruction_error');
    expect(summary.userMessage).toMatch(/Instruction 0 failed/i);
  });

  test('extracts program/anchor errors from logs', () => {
    const logs = [
      'Program RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87 invoke [1]',
      'Program log: AnchorError occurred. Error Code: CalculationError. Error Number: 6027. Error Message: Calculation error.',
      'Program RaptorD5ojtsqDDtJeRsunPLg6GvLYNnwKJWxYE4m87 failed: custom program error: 0x178b',
    ];
    const summary = classifySolanaError(new Error('Transaction simulation failed'), { logs });
    expect(summary.kind).toBe('program_error');
    expect(summary.programError.anchorError.number).toBe(6027);
    expect(summary.userMessage).toMatch(/CalculationError/i);
  });

  test('marks transport errors as retryable', () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    const summary = classifySolanaError(err);
    expect(summary.kind).toBe('rpc_transport');
    expect(summary.retryable).toBe(true);
  });

  test('shouldRetryRpcError allows transient read failures', () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    expect(shouldRetryRpcError('getBalance', err)).toBe(true);
    expect(shouldRetryRpcError('sendTransaction', err)).toBe(false);
  });
});
