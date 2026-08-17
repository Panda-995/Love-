import { listMedia } from '../../utils/media'
export default defineEventHandler(event => listMedia(event, String(getQuery(event).bucket || ''), getQuery(event).path, getQuery(event).limit))
