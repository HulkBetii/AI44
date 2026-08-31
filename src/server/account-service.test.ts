import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountIdentityConflictError, AccountService } from './account-service';
import type { AccountRow } from './domain';

function row(rowIndex: number, email: string): AccountRow {
  return {
    rowIndex,
    email,
    password: `hotmail-${rowIndex}`,
    msaToken: '',
    tenantGuid: '',
    recoveryEmail: '',
    apiKey: `api-${rowIndex}`,
    elevenPass: `eleven-${rowIndex}`,
    status: 'complete',
  };
}

function serviceWithRows(rows: AccountRow[]): AccountService {
  const service = new AccountService(process.cwd(), { get: () => ({}) } as never);
  vi.spyOn(service, 'rows').mockResolvedValue(rows);
  return service;
}

afterEach(() => vi.restoreAllMocks());

describe('AccountService secret reveal identity', () => {
  it('reveals only a unique normalized email at the expected row', async () => {
    const service = serviceWithRows([row(49, ' Operator@Example.com ')]);

    await expect(service.reveal(49, 'apiKey', 'operator@example.com')).resolves.toBe('api-49');
  });

  it('fails closed when the email moved to another row', async () => {
    const service = serviceWithRows([
      row(25, 'replacement@example.com'),
      row(49, 'operator@example.com'),
    ]);

    await expect(service.reveal(25, 'apiKey', 'operator@example.com'))
      .rejects.toBeInstanceOf(AccountIdentityConflictError);
  });

  it('fails closed when the expected email is duplicated', async () => {
    const service = serviceWithRows([
      row(25, 'operator@example.com'),
      row(49, 'OPERATOR@example.com'),
    ]);

    await expect(service.reveal(25, 'hotmailPassword', 'operator@example.com'))
      .rejects.toBeInstanceOf(AccountIdentityConflictError);
  });
});
