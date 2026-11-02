import { BadRequestException } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';

describe('workspace names', () => {
  it('rejects a non-string name before touching the database', async () => {
    const db = { query: jest.fn() };
    const workspaces = new WorkspacesService(db as never);
    await expect(
      workspaces.create('11111111-1111-4111-8111-111111111111', 12 as unknown as string),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });
});
