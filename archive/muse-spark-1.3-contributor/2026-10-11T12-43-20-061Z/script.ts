var cachedMe = -1;
function an(a: number[], i: number): number {
var v = a[i];
if (v === undefined) return 0;
return v;
}
function as(a: string[], i: number): string {
var v = a[i];
if (v === undefined) return "";
return v;
}
function loop() {
try {
var me = getMyIndex();
cachedMe = me;
var tick = getTick();
var players = getObjectsByType("player");
var myMoney = 0;
for (var pi = 0; pi < players.length; pi += 1) {
var pp = players[pi];
if (pp === undefined) continue;
if (pp.index === me) { myMoney = pp.resources; break; }
}
var sites = getObjectsByType("site");
var myBaseIds: number[] = [];
var myBaseXs: number[] = [];
var myBaseYs: number[] = [];
var myBaseBusy: number[] = [];
var myResIds: number[] = [];
var myResXs: number[] = [];
var myResYs: number[] = [];
var capIds: number[] = [];
var capXs: number[] = [];
var capYs: number[] = [];
var capIsBase: number[] = [];
var capOwner: number[] = [];
var capProg: number[] = [];
for (var si = 0; si < sites.length; si += 1) {
var s = sites[si];
if (s === undefined) continue;
if (s.owner === me) {
if (s.kind === "base") {
myBaseIds.push(s.id);
myBaseXs.push(s.x);
myBaseYs.push(s.y);
if (s.producing !== null) myBaseBusy.push(1);
else myBaseBusy.push(0);
} else {
var rr = s.remaining;
if (rr === undefined) {
myResIds.push(s.id);
myResXs.push(s.x);
myResYs.push(s.y);
} else {
if (rr > 0) {
myResIds.push(s.id);
myResXs.push(s.x);
myResYs.push(s.y);
}
}
}
} else {
capIds.push(s.id);
capXs.push(s.x);
capYs.push(s.y);
if (s.kind === "base") capIsBase.push(1);
else capIsBase.push(0);
capOwner.push(s.owner);
capProg.push(s.progressOwner);
}
}
var allU = getObjectsByType("unit");
var myIds: number[] = [];
var myTp: string[] = [];
var myXs: number[] = [];
var myYs: number[] = [];
var myCa: number[] = [];
var foeIds: number[] = [];
var foeXs: number[] = [];
var foeYs: number[] = [];
var foeHp: number[] = [];
var wC = 0;
var mC = 0;
var rC = 0;
var cC = 0;
for (var ui = 0; ui < allU.length; ui += 1) {
var u = allU[ui];
if (u === undefined) continue;
if (u.owner === me) {
myIds.push(u.id);
myTp.push(u.type);
myXs.push(u.x);
myYs.push(u.y);
myCa.push(u.carrying);
if (u.type === "worker") wC += 1;
else if (u.type === "melee") mC += 1;
else if (u.type === "ranged") rC += 1;
else cC += 1;
} else {
foeIds.push(u.id);
foeXs.push(u.x);
foeYs.push(u.y);
foeHp.push(u.hp);
}
}
var foeN = foeIds.length;
if (foeN > 60) foeN = 60;
var threat = 0;
var threatX = 0;
var threatY = 0;
for (var fi = 0; fi < foeN; fi += 1) {
if (threat === 1) break;
var fx0 = an(foeXs, fi);
var fy0 = an(foeYs, fi);
for (var bj0 = 0; bj0 < myBaseXs.length; bj0 += 1) {
var bx0 = an(myBaseXs, bj0);
var by0 = an(myBaseYs, bj0);
var ddx0 = fx0 - bx0;
if (ddx0 < 0) ddx0 = 0 - ddx0;
var ddy0 = fy0 - by0;
if (ddy0 < 0) ddy0 = 0 - ddy0;
var dd0 = ddx0;
if (ddy0 > ddx0) dd0 = ddy0;
if (dd0 <= 5) { threat = 1; threatX = fx0; threatY = fy0; break; }
}
}
var moneyLeft = myMoney;
for (var bi = 0; bi < myBaseIds.length; bi += 1) {
if (an(myBaseBusy, bi) === 1) continue;
var bId = an(myBaseIds, bi);
var wantW = 5;
if (myResIds.length >= 2) wantW = 7;
if (myResIds.length >= 3) wantW = 8;
if (capIds.length === 0) wantW = 4;
if (tick > 400) wantW = 4;
if (wC < wantW) {
if (moneyLeft >= 4) { spawnUnit(bId, "worker"); moneyLeft = moneyLeft - 4; wC += 1; }
continue;
} else {
var wantR = 0;
if (mC >= rC * 2 + 3) wantR = 1;
if (wantR === 1) {
if (moneyLeft >= 12) { spawnUnit(bId, "ranged"); moneyLeft = moneyLeft - 12; rC += 1; }
else if (moneyLeft >= 8) { spawnUnit(bId, "melee"); moneyLeft = moneyLeft - 8; mC += 1; }
else if (moneyLeft >= 4) { spawnUnit(bId, "worker"); moneyLeft = moneyLeft - 4; wC += 1; }
} else {
if (moneyLeft >= 8) { spawnUnit(bId, "melee"); moneyLeft = moneyLeft - 8; mC += 1; }
else if (moneyLeft >= 4) { spawnUnit(bId, "worker"); moneyLeft = moneyLeft - 4; wC += 1; }
}
}
}
var capAssign: number[] = [];
for (var cai = 0; cai < capIds.length; cai += 1) capAssign.push(0);
for (var mi = 0; mi < myIds.length; mi += 1) {
var uid = an(myIds, mi);
var utp = as(myTp, mi);
var ux = an(myXs, mi);
var uy = an(myYs, mi);
var uca = an(myCa, mi);
if (utp === "worker") {
if (uca >= 20) {
if (myBaseIds.length === 0) {
if (capIds.length === 0) continue;
var bci = -1;
var bcd = 1000000;
for (var ci3 = 0; ci3 < capIds.length; ci3 += 1) {
if (an(capAssign, ci3) >= 2) continue;
var ccx3 = an(capXs, ci3);
var ccy3 = an(capYs, ci3);
var tdx3 = ux - ccx3;
if (tdx3 < 0) tdx3 = 0 - tdx3;
var tdy3 = uy - ccy3;
if (tdy3 < 0) tdy3 = 0 - tdy3;
var tdd3 = tdx3;
if (tdy3 > tdx3) tdd3 = tdy3;
if (tdd3 < bcd) { bcd = tdd3; bci = ci3; }
}
if (bci === -1) {
var bcd2 = 1000000;
var bci2 = -1;
for (var ci3b = 0; ci3b < capIds.length; ci3b += 1) {
var ccx3b = an(capXs, ci3b);
var ccy3b = an(capYs, ci3b);
var tdx3b = ux - ccx3b;
if (tdx3b < 0) tdx3b = 0 - tdx3b;
var tdy3b = uy - ccy3b;
if (tdy3b < 0) tdy3b = 0 - tdy3b;
var tdd3b = tdx3b;
if (tdy3b > tdx3b) tdd3b = tdy3b;
if (tdd3b < bcd2) { bcd2 = tdd3b; bci2 = ci3b; }
}
if (bci2 !== -1) {
capAssign[bci2] = an(capAssign, bci2) + 1;
if (bcd2 === 0) continue;
var txb0 = an(capXs, bci2);
var tyb0 = an(capYs, bci2);
moveTo(uid, txb0, tyb0);
}
continue;
}
capAssign[bci] = an(capAssign, bci) + 1;
if (bcd === 0) continue;
var txc = an(capXs, bci);
var tyc = an(capYs, bci);
moveTo(uid, txc, tyc);
continue;
}
var nearBX = 0;
var nearBY = 0;
var nearBD = 1000000;
var adjB = 0;
var onB = 0;
for (var bj1 = 0; bj1 < myBaseXs.length; bj1 += 1) {
var qbx = an(myBaseXs, bj1);
var qby = an(myBaseYs, bj1);
var qdx = ux - qbx;
if (qdx < 0) qdx = 0 - qdx;
var qdy = uy - qby;
if (qdy < 0) qdy = 0 - qdy;
var qdd = qdx;
if (qdy > qdx) qdd = qdy;
if (qdd < nearBD) { nearBD = qdd; nearBX = qbx; nearBY = qby; }
if (qdd <= 1) adjB = 1;
if (qdd === 0) onB = 1;
}
if (onB === 1) { move(uid, 1, 0); continue; }
if (adjB === 1) { transfer(uid); continue; }
moveTo(uid, nearBX, nearBY);
continue;
} else {
if (myResIds.length === 0) {
if (uca > 0 && myBaseIds.length > 0) {
var nBX0 = 0;
var nBY0 = 0;
var nBD0 = 1000000;
var aB0 = 0;
for (var bj2 = 0; bj2 < myBaseXs.length; bj2 += 1) {
var rbx = an(myBaseXs, bj2);
var rby = an(myBaseYs, bj2);
var rdx = ux - rbx;
if (rdx < 0) rdx = 0 - rdx;
var rdy = uy - rby;
if (rdy < 0) rdy = 0 - rdy;
var rdd = rdx;
if (rdy > rdx) rdd = rdy;
if (rdd < nBD0) { nBD0 = rdd; nBX0 = rbx; nBY0 = rby; }
if (rdd <= 1) aB0 = 1;
}
if (aB0 === 1) { transfer(uid); continue; }
}
if (capIds.length === 0) continue;
var wci = -1;
var wcd = 1000000;
for (var ci4 = 0; ci4 < capIds.length; ci4 += 1) {
if (an(capAssign, ci4) >= 3) continue;
var wcx = an(capXs, ci4);
var wcy = an(capYs, ci4);
var wdx = ux - wcx;
if (wdx < 0) wdx = 0 - wdx;
var wdy = uy - wcy;
if (wdy < 0) wdy = 0 - wdy;
var wdd = wdx;
if (wdy > wdx) wdd = wdy;
if (wdd < wcd) { wcd = wdd; wci = ci4; }
}
if (wci === -1) continue;
capAssign[wci] = an(capAssign, wci) + 1;
if (wcd === 0) continue;
var wtx = an(capXs, wci);
var wty = an(capYs, wci);
moveTo(uid, wtx, wty);
continue;
} else {
var bestRI = -1;
var bestRD = 1000000;
var bestRX = 0;
var bestRY = 0;
var bestRId = 0;
for (var ri = 0; ri < myResIds.length; ri += 1) {
var rsx = an(myResXs, ri);
var rsy = an(myResYs, ri);
var sdx = ux - rsx;
if (sdx < 0) sdx = 0 - sdx;
var sdy = uy - rsy;
if (sdy < 0) sdy = 0 - sdy;
var sdd = sdx;
if (sdy > sdx) sdd = sdy;
if (sdd < bestRD) { bestRD = sdd; bestRI = ri; bestRX = rsx; bestRY = rsy; bestRId = an(myResIds, ri); }
}
if (bestRI === -1) continue;
if (bestRD === 0) {
if (myBaseXs.length > 0) {
var obx = an(myBaseXs, 0);
var oby = an(myBaseYs, 0);
moveTo(uid, obx, oby);
} else {
move(uid, 1, 0);
}
continue;
}
if (bestRD <= 1) { harvest(uid, bestRId); continue; }
moveTo(uid, bestRX, bestRY);
continue;
}
}
} else {
var myR = 1;
if (utp === "ranged") myR = 2;
var chaseR = 5;
if (utp === "ranged") chaseR = 6;
if (utp === "cavalry") chaseR = 7;
var bestT = -1;
var bestTHp = 1000000;
var nearF = -1;
var nearFX = 0;
var nearFY = 0;
var nearFD = 1000000;
for (var fj = 0; fj < foeN; fj += 1) {
var fI = an(foeIds, fj);
var fX = an(foeXs, fj);
var fY = an(foeYs, fj);
var fH = an(foeHp, fj);
var edx = ux - fX;
if (edx < 0) edx = 0 - edx;
var edy = uy - fY;
if (edy < 0) edy = 0 - edy;
var edd = edx;
if (edy > edx) edd = edy;
if (edd < nearFD) { nearFD = edd; nearF = fI; nearFX = fX; nearFY = fY; }
if (edd <= myR) {
if (fH < bestTHp) { bestTHp = fH; bestT = fI; }
}
}
if (bestT !== -1) { attack(uid, bestT); continue; }
if (nearF !== -1 && nearFD <= chaseR) { moveTo(uid, nearFX, nearFY); continue; }
if (threat === 1) { moveTo(uid, threatX, threatY); continue; }
if (capIds.length === 0) {
if (nearF !== -1) { moveTo(uid, nearFX, nearFY); continue; }
var onB2 = 0;
for (var bj3 = 0; bj3 < myBaseXs.length; bj3 += 1) {
var obx2 = an(myBaseXs, bj3);
var oby2 = an(myBaseYs, bj3);
if (ux === obx2 && uy === oby2) { onB2 = 1; break; }
}
if (onB2 === 1) {
if (myResXs.length > 0) {
var ex0 = an(myResXs, 0);
var ey0 = an(myResYs, 0);
moveTo(uid, ex0, ey0);
} else {
move(uid, 1, 0);
}
}
continue;
} else {
var cBest = -1;
var cBestD = 1000000;
for (var ci = 0; ci < capIds.length; ci += 1) {
if (an(capAssign, ci) >= 2) continue;
var ccx = an(capXs, ci);
var ccy = an(capYs, ci);
var cdx = ux - ccx;
if (cdx < 0) cdx = 0 - cdx;
var cdy = uy - ccy;
if (cdy < 0) cdy = 0 - cdy;
var cdd = cdx;
if (cdy > cdx) cdd = cdy;
var isB = an(capIsBase, ci);
var oW = an(capOwner, ci);
var pW = an(capProg, ci);
if (tick < 250 && isB === 1) cdd = cdd + 4;
if (tick < 300 && oW !== -1 && oW !== me) cdd = cdd + 2;
if (pW === me) cdd = cdd - 2;
if (cdd < cBestD) { cBestD = cdd; cBest = ci; }
}
if (cBest === -1) {
var fD = 1000000;
var fb = -1;
for (var ci2 = 0; ci2 < capIds.length; ci2 += 1) {
var ddx2 = an(capXs, ci2);
var ddy2 = an(capYs, ci2);
var qdx2 = ux - ddx2;
if (qdx2 < 0) qdx2 = 0 - qdx2;
var qdy2 = uy - ddy2;
if (qdy2 < 0) qdy2 = 0 - qdy2;
var qdd2 = qdx2;
if (qdy2 > qdx2) qdd2 = qdy2;
if (qdd2 < fD) { fD = qdd2; fb = ci2; }
}
if (fb !== -1) {
cBest = fb;
capAssign[cBest] = an(capAssign, cBest) + 1;
if (fD === 0) continue;
var gX = an(capXs, cBest);
var gY = an(capYs, cBest);
moveTo(uid, gX, gY);
}
continue;
} else {
capAssign[cBest] = an(capAssign, cBest) + 1;
var gx0 = an(capXs, cBest);
var gy0 = an(capYs, cBest);
var rdx0 = ux - gx0;
if (rdx0 < 0) rdx0 = 0 - rdx0;
var rdy0 = uy - gy0;
if (rdy0 < 0) rdy0 = 0 - rdy0;
var realD = rdx0;
if (rdy0 > rdx0) realD = rdy0;
if (realD === 0) continue;
moveTo(uid, gx0, gy0);
continue;
}
}
}
}
} catch (e) { }
}