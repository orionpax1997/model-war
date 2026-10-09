# 02: 对局校验统一到回放唯一读入端

**What to build:** 对局校验走回放包的唯一读入端,不再自带第四份读入逻辑;其余三处读入逻辑不动,本票只收这一份分叉,并有测试盯着统一不断。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 对局校验经唯一读入端取行,自家读入分叉已删除
- [ ] 既有校验断言全绿,新增统一不断的测试
