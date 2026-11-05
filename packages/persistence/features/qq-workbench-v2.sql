-- Additive QQ report-history pagination index. Published v1 SQL and main ledger stay unchanged.
CREATE INDEX qq_report_history_page ON report_revisions(project_id,window_end DESC,report_id DESC,revision DESC);
