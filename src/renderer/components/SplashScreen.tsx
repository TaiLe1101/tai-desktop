import { Box, Stack, Typography } from '@mui/material';
import logoUrl from '../assets/logo.png';

interface SplashScreenProps {
  currentVersion: string;
}

export function SplashScreen({ currentVersion }: SplashScreenProps) {
  return (
    <Box
      sx={{
        flex: 1,
        width: '100%',
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(circle at 50% 35%, #132544 0%, #0b1018 65%)',
        userSelect: 'none'
      }}
    >
      <Stack sx={{ alignItems: 'center', gap: 2.2 }}>
        <Box
          sx={{
            p: 1,
            borderRadius: 5,
            background: 'linear-gradient(135deg, rgba(34, 211, 238, 0.25), rgba(59, 130, 246, 0.2))',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.55), 0 0 32px rgba(56, 189, 248, 0.18)'
          }}
        >
          <Box
            component="img"
            src={logoUrl}
            alt="TAI Desktop logo"
            sx={{
              width: 88,
              height: 88,
              borderRadius: 4,
              objectFit: 'cover',
              display: 'block'
            }}
          />
        </Box>

        <Stack sx={{ alignItems: 'center', gap: 0.4 }}>
          <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.02em', color: '#f1f5f9' }}>
            TAI Desktop
          </Typography>
          {currentVersion && (
            <Typography variant="caption" sx={{ color: '#98baff', fontWeight: 600, fontSize: 13 }}>
              v{currentVersion}
            </Typography>
          )}
        </Stack>

        <div className="splash-wave" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>

        <Typography variant="body2" sx={{ color: '#94a3b8', fontWeight: 500 }}>
          Đang khởi động...
        </Typography>
      </Stack>
    </Box>
  );
}
