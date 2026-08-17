import { serveMedia } from '../../../utils/media'

export default defineEventHandler(event => serveMedia(event, getRouterParam(event, 'bucket') || '', getRouterParam(event, 'path') || ''))
