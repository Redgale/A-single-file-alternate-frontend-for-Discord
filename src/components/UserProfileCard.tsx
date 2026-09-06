import { useEffect, useRef, useState } from 'preact/hooks'
import { type PresenceStatus, type UserProfile, avatarUrl, bannerUrl, getUserProfile } from '../discord/rest'

const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
}

interface Props {
  userId: string
  anchor: { x: number; y: number }
  status?: PresenceStatus
  onClose: () => void
}

export function UserProfileCard({ userId, anchor, status, onClose }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [error, setError] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    getUserProfile(userId)
      .then((p) => !cancelled && setProfile(p))
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [userId])

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onOutsideClick)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onOutsideClick)
      document.removeEventListener('keydown', onEscape)
    }
  }, [onClose])

  const banner = profile ? bannerUrl(profile.user.id, profile.user.banner) : null
  const accentColor = profile?.user.accent_color != null ? `#${profile.user.accent_color.toString(16).padStart(6, '0')}` : undefined

  return (
    <div
      class="profile-card"
      ref={cardRef}
      style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
    >
      {error && <div class="profile-card-error">Couldn't load profile</div>}
      {!error && (
        <>
          <div class="profile-banner" style={{ background: banner ? undefined : accentColor ?? 'var(--bg-surface)' }}>
            {banner && <img src={banner} alt="" />}
          </div>
          <span class="profile-avatar-wrap">
            <img class="profile-avatar" src={avatarUrl(userId, profile?.user.avatar ?? null, 80)} alt="" />
            <span class={`status-dot status-${status ?? 'offline'} profile-status-dot`} />
          </span>
          <div class="profile-body">
            <div class="profile-display-name">{profile?.user.global_name || profile?.user.username || '…'}</div>
            <div class="profile-username">@{profile?.user.username ?? ''}</div>
            <div class="profile-status-label">{STATUS_LABEL[status ?? 'offline']}</div>
            {profile?.user.bio && <div class="profile-bio">{profile.user.bio}</div>}
          </div>
        </>
      )}
    </div>
  )
}
