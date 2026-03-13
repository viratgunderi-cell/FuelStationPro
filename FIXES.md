
## 🐛 Bug Fix (this session)
- **BUG-EMP-LOGIN**: Employee login showing "Select employee" error even after selecting employee.
  - Root cause: `doEmpLogin()` searched `EMP_LIST` (which reads from `APP.data.employees` preload) 
    but the dropdown was populated by `fetchPublicEmployees()` → `fb_emp_cache`. When the two 
    sources are out of sync, the ID lookup fails.
  - Fix: Added `fb_emp_cache` fallback lookup in both `doEmpLogin()` and `emp_doLogin()`.
    Also fixed strict `===` comparison to `parseInt()` on both sides for type safety.
