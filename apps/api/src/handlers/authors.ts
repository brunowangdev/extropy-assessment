import { badRequest } from '../lib/errors.js';
import { json, withHttp } from '../lib/http.js';
import { getAuthorProfile } from '../services/authors.js';

export const getProfile = withHttp(async (event) => {
  const id = event.pathParameters?.id;
  if (!id) throw badRequest('Missing author id');
  const profile = await getAuthorProfile(id);
  return json(200, profile);
});
