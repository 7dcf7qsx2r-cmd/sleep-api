export function productIdConflict(error: unknown): { error: 'id_taken'; message: string } | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  if ((error as { code?: string }).code !== '23505') return null;
  const detail = 'detail' in error && typeof (error as { detail?: unknown }).detail === 'string'
    ? (error as { detail: string }).detail
    : '';
  const id = /Key \(id\)=\((.*)\) already exists/.exec(detail)?.[1];
  return {
    error: 'id_taken',
    message: id
      ? `商品 ID「${id}」已经存在，请换一个，或留空让系统自动生成`
      : '商品 ID 已经存在，请换一个，或留空让系统自动生成',
  };
}
