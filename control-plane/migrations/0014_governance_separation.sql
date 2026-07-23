ALTER TABLE production_governance_policies ADD COLUMN require_separate_verifier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE production_governance_policies ADD COLUMN require_separate_deployer INTEGER NOT NULL DEFAULT 0;
