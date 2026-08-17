import { handleDataRequest } from '../utils/data-api'

export default defineEventHandler(async event => handleDataRequest(event, await readBody(event)))
