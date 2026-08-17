import { getUser } from '../../utils/auth'

export default defineEventHandler(event => {
  const user = getUser(event)
  return { user: user ? { id: user.id, email: `${user.username}@local.love-home`, user_metadata: { display_name: user.displayName, username: user.username } } : null }
})
