import { resolveUploadedSkills } from '../../../src/config/skill-upload.ts';

/** Resolves the posted bytes as one uploaded archive with workerd's own DecompressionStream. */
export default {
  async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).searchParams.get('name') ?? 'upload.zip';
    const bytes = new Uint8Array(await request.arrayBuffer());
    return Response.json(await resolveUploadedSkills([{ name, bytes }]));
  },
};
