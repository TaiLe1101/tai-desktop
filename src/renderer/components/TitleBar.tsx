import CloseRounded from '@mui/icons-material/CloseRounded';
import CropSquareRounded from '@mui/icons-material/CropSquareRounded';
import FilterNoneRounded from '@mui/icons-material/FilterNoneRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import { Box, IconButton, Stack, Typography } from '@mui/material';
import logoUrl from '../assets/logo.png';

interface TitleBarProps {
  currentVersion: string;
  isMaximized: boolean;
  onRequestClose: () => void;
}

export function TitleBar({ currentVersion, isMaximized, onRequestClose }: TitleBarProps) {
  return (
    <Box
      className="titlebar-drag"
      onDoubleClick={() => { void window.tai.windowToggleMaximize().catch(() => {}); }}
      sx={{
        height: 38,
        minHeight: 38,
        px: 1.25,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        bgcolor: '#080c13',
        borderBottom: '1px solid #1e293b',
        userSelect: 'none',
        flexShrink: 0,
        zIndex: 1400
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box
          component="img"
          src={logoUrl}
          alt="TAI Desktop"
          sx={{
            width: 22,
            height: 22,
            borderRadius: 1,
            objectFit: 'cover',
            border: '1px solid rgba(152, 186, 255, 0.3)'
          }}
        />
        <Typography variant="body2" sx={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.01em', color: '#e6eefc' }} noWrap>
          TAI Desktop
        </Typography>
        {currentVersion && (
          <Typography
            variant="caption"
            sx={{
              px: 0.75,
              py: 0.1,
              borderRadius: 1,
              bgcolor: 'rgba(152, 186, 255, 0.12)',
              color: '#98baff',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.4
            }}
          >
            v{currentVersion}
          </Typography>
        )}
      </Stack>

      <Stack direction="row" className="titlebar-nodrag" sx={{ alignItems: 'center', gap: 0.25 }}>
        <IconButton
          size="small"
          aria-label="Thu nhỏ"
          title="Thu nhỏ"
          onClick={() => { void window.tai.windowMinimize().catch(() => {}); }}
          sx={{
            width: 34,
            height: 28,
            borderRadius: 1.25,
            color: '#cbd5e1',
            '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.1)', color: '#fff' }
          }}
        >
          <RemoveRounded sx={{ fontSize: 18 }} />
        </IconButton>

        <IconButton
          size="small"
          aria-label={isMaximized ? 'Khôi phục cửa sổ' : 'Phóng to'}
          title={isMaximized ? 'Khôi phục cửa sổ' : 'Phóng to'}
          onClick={() => { void window.tai.windowToggleMaximize().catch(() => {}); }}
          sx={{
            width: 34,
            height: 28,
            borderRadius: 1.25,
            color: '#cbd5e1',
            '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.1)', color: '#fff' }
          }}
        >
          {isMaximized
            ? <FilterNoneRounded sx={{ fontSize: 14, transform: 'rotate(180deg)' }} />
            : <CropSquareRounded sx={{ fontSize: 16 }} />}
        </IconButton>

        <IconButton
          size="small"
          aria-label="Đóng ứng dụng"
          title="Đóng ứng dụng"
          onClick={onRequestClose}
          sx={{
            width: 34,
            height: 28,
            borderRadius: 1.25,
            color: '#cbd5e1',
            '&:hover': { bgcolor: '#dc2626', color: '#fff' }
          }}
        >
          <CloseRounded sx={{ fontSize: 18 }} />
        </IconButton>
      </Stack>
    </Box>
  );
}
