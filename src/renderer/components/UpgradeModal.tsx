import Check from '@mui/icons-material/Check';
import Close from '@mui/icons-material/Close';
import WorkspacePremium from '@mui/icons-material/WorkspacePremium';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material';
import { useEffect, useState } from 'react';
import { formatVnd } from '../../shared/saas';
import type { EntitlementDto, PlanDto, UpgradeRequestDto } from '../../shared/types';

interface UpgradeModalProps {
  open: boolean;
  entitlement: EntitlementDto | null;
  onClose: () => void;
  onSubmitted?: () => void;
}

const requestStatusLabel: Record<UpgradeRequestDto['status'], { label: string; color: 'warning' | 'success' | 'error' }> = {
  PENDING: { label: 'Đang chờ duyệt', color: 'warning' },
  APPROVED: { label: 'Đã duyệt', color: 'success' },
  REJECTED: { label: 'Từ chối', color: 'error' }
};

export function UpgradeModal({ open, entitlement, onClose, onSubmitted }: UpgradeModalProps) {
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [requests, setRequests] = useState<UpgradeRequestDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [contactNote, setContactNote] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [planList, reqList] = await Promise.all([
        window.tai.listPublicPlans(),
        window.tai.listUpgradeRequests().catch(() => [])
      ]);
      setPlans(planList);
      setRequests(reqList);
      const currentPlanId = entitlement?.plan?.id;
      const defaultPick = planList.find(p => p.isHighlighted && p.id !== currentPlanId)
        || planList.find(p => p.priceMonthly > 0 && p.id !== currentPlanId)
        || planList[0];
      if (defaultPick) setSelectedPlanId(prev => prev ?? defaultPick.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setSuccess('');
      void loadData();
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!selectedPlanId) return;
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const created = await window.tai.createUpgradeRequest({
        planId: selectedPlanId,
        billingCycle,
        contactNote: contactNote.trim() || undefined
      });
      setRequests(prev => [created, ...prev]);
      setContactNote('');
      setSuccess('Đã gửi yêu cầu nâng cấp thành công! Quản trị viên sẽ liên hệ và kích hoạt gói sớm nhất.');
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const currentPlanId = entitlement?.plan?.id;
  const pendingRequest = requests.find(r => r.status === 'PENDING');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <WorkspacePremium color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Nâng cấp gói dịch vụ TAI Desktop</Typography>
        </Stack>
        <IconButton onClick={onClose} size="small" aria-label="Đóng"><Close /></IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Stack sx={{ gap: 2.5 }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Gói hiện tại: <strong>{entitlement?.plan?.name || 'Chưa kích hoạt'}</strong>
              {entitlement?.tenant?.name ? ` · ${entitlement.tenant.name}` : ''}
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={billingCycle}
              onChange={(_e, val) => { if (val) setBillingCycle(val); }}
            >
              <ToggleButton value="MONTHLY">Theo tháng</ToggleButton>
              <ToggleButton value="YEARLY">Theo năm (Tiết kiệm)</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          {pendingRequest && (
            <Alert severity="info">
              Bạn đang có yêu cầu nâng cấp lên gói <strong>{pendingRequest.requestedPlan?.name || `#${pendingRequest.requestedPlanId}`}</strong> ({pendingRequest.billingCycle === 'YEARLY' ? 'Theo năm' : 'Theo tháng'}) — <strong>Đang chờ quản trị viên duyệt</strong>.
            </Alert>
          )}
          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
          {success && <Alert severity="success" onClose={() => setSuccess('')}>{success}</Alert>}

          {loading ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 5 }}>
              <CircularProgress />
            </Box>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
              {plans.map(plan => {
                const isSelected = selectedPlanId === plan.id;
                const isCurrent = currentPlanId === plan.id;
                const price = billingCycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
                const yearlySavePct = plan.priceMonthly > 0 && plan.priceYearly > 0
                  ? Math.max(0, Math.round((1 - plan.priceYearly / (plan.priceMonthly * 12)) * 100))
                  : 0;
                return (
                  <Paper
                    key={plan.id}
                    variant="outlined"
                    onClick={() => setSelectedPlanId(plan.id)}
                    sx={{
                      p: 2,
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1.2,
                      borderWidth: isSelected ? 2 : 1,
                      borderColor: isSelected ? 'primary.main' : plan.isHighlighted ? 'rgba(152,186,255,0.45)' : '#263242',
                      bgcolor: isSelected ? 'rgba(152,186,255,0.08)' : 'background.paper',
                      transition: 'border-color 0.15s ease, background-color 0.15s ease'
                    }}
                  >
                    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
                      <Typography sx={{ fontWeight: 700, fontSize: 16 }}>{plan.name}</Typography>
                      {isCurrent ? (
                        <Chip size="small" label="Đang dùng" color="success" />
                      ) : plan.badge ? (
                        <Chip size="small" label={plan.badge} color="primary" variant="outlined" />
                      ) : null}
                    </Stack>

                    <Box>
                      <Typography variant="h5" sx={{ fontWeight: 800, color: '#98baff' }}>
                        {formatVnd(price, plan.currency)}
                        {price > 0 && (
                          <Typography component="span" variant="caption" color="text.secondary">
                            {billingCycle === 'YEARLY' ? ' / năm' : ' / tháng'}
                          </Typography>
                        )}
                      </Typography>
                      {billingCycle === 'YEARLY' && yearlySavePct > 0 && (
                        <Typography variant="caption" color="success.main">Tiết kiệm {yearlySavePct}%</Typography>
                      )}
                    </Box>

                    <Typography variant="body2" color="text.secondary" sx={{ minHeight: 34 }}>
                      {plan.description || (plan.monthlyMinutesLimit === null
                        ? 'Không giới hạn phút lồng tiếng'
                        : `${plan.monthlyMinutesLimit.toLocaleString('vi-VN')} phút lồng tiếng / tháng`)}
                    </Typography>

                    <Divider />

                    <Stack sx={{ gap: 0.7, flex: 1 }}>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                        • Hạn mức: {plan.monthlyMinutesLimit === null ? 'Không giới hạn' : `${plan.monthlyMinutesLimit.toLocaleString('vi-VN')} phút/tháng`}
                      </Typography>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                        • Tối đa {plan.maxSeats} thành viên
                      </Typography>
                      {(plan.features || []).map((feat, idx) => (
                        <Stack key={idx} direction="row" sx={{ gap: 0.6, alignItems: 'flex-start' }}>
                          <Check sx={{ fontSize: 14, mt: '2px', color: 'primary.main', flexShrink: 0 }} />
                          <Typography variant="caption" color="text.secondary">{feat}</Typography>
                        </Stack>
                      ))}
                    </Stack>
                  </Paper>
                );
              })}
            </Box>
          )}

          <Stack sx={{ gap: 1.5, pt: 1 }}>
            <TextField
              label="Thông tin liên hệ / Ghi chú (SĐT, Zalo, nhu cầu sử dụng)"
              placeholder="Ví dụ: Zalo 09xx.xxx.xxx — muốn nâng cấp gói Pro theo tháng"
              value={contactNote}
              onChange={e => setContactNote(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={2}
              disabled={submitting}
            />
            <Stack direction="row" sx={{ justifyContent: 'flex-end', gap: 1.5 }}>
              <Button onClick={onClose} color="inherit">Đóng</Button>
              <Button
                variant="contained"
                startIcon={<WorkspacePremium />}
                disabled={submitting || !selectedPlanId}
                onClick={() => void handleSubmit()}
              >
                {submitting ? 'Đang gửi…' : 'Gửi yêu cầu nâng cấp'}
              </Button>
            </Stack>
          </Stack>

          {requests.length > 0 && (
            <Box>
              <Divider sx={{ mb: 1.5 }} />
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Lịch sử yêu cầu gần đây</Typography>
              <Stack sx={{ gap: 0.8 }}>
                {requests.slice(0, 5).map(req => {
                  const meta = requestStatusLabel[req.status];
                  return (
                    <Stack key={req.id} direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.2, py: 0.8, borderRadius: 1.5, bgcolor: 'rgba(255,255,255,0.03)' }}>
                      <Typography variant="caption">
                        Gói <strong>{req.requestedPlan?.name || `#${req.requestedPlanId}`}</strong> ({req.billingCycle === 'YEARLY' ? 'Năm' : 'Tháng'})
                        {req.adminNote ? ` · Ghi chú admin: ${req.adminNote}` : ''}
                      </Typography>
                      <Chip size="small" label={meta.label} color={meta.color} variant="outlined" />
                    </Stack>
                  );
                })}
              </Stack>
            </Box>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
