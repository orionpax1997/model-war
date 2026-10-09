"use strict";
var gMe = -1;
var gSeed = 0;
function absInt(v) {
    return v < 0 ? -v : v;
}
function cheb(ax, ay, bx, by) {
    var dx = absInt(ax - bx);
    var dy = absInt(ay - by);
    return dx > dy ? dx : dy;
}
function signInt(v) {
    if (v > 0) {
        return 1;
    }
    if (v < 0) {
        return -1;
    }
    return 0;
}
function loop() {
    var me = getMyIndex();
    gMe = me;
    var tick = getTick();
    gSeed = tick;
    var players = getObjectsByType("player");
    var myRes = 0;
    var pi = 0;
    for (pi = 0; pi < players.length; pi += 1) {
        var p = players[pi];
        if (p === undefined) {
            continue;
        }
        if (p.index === me) {
            myRes = p.resources;
        }
    }
    var sites = getObjectsByType("site");
    var units = getObjectsByType("unit");
    var myBasesX = [];
    var myBasesY = [];
    var myBasesId = [];
    var myBasesProdNull = [];
    var myMineX = [];
    var myMineY = [];
    var myMineId = [];
    var capX = [];
    var capY = [];
    var capKindIsBase = [];
    var si = 0;
    for (si = 0; si < sites.length; si += 1) {
        var s = sites[si];
        if (s === undefined) {
            continue;
        }
        if (s.owner === me) {
            if (s.kind === "base") {
                myBasesX.push(s.x);
                myBasesY.push(s.y);
                myBasesId.push(s.id);
                if (s.producing === null) {
                    myBasesProdNull.push(1);
                }
                else {
                    myBasesProdNull.push(0);
                }
            }
            else {
                var rem = s.remaining;
                if (rem === undefined) {
                    myMineX.push(s.x);
                    myMineY.push(s.y);
                    myMineId.push(s.id);
                }
                else {
                    if (rem > 0) {
                        myMineX.push(s.x);
                        myMineY.push(s.y);
                        myMineId.push(s.id);
                    }
                }
            }
        }
        else {
            capX.push(s.x);
            capY.push(s.y);
            if (s.kind === "base") {
                capKindIsBase.push(1);
            }
            else {
                capKindIsBase.push(0);
            }
        }
    }
    var ui = 0;
    var myUX = [];
    var myUY = [];
    var myUT = [];
    var myUCarry = [];
    var myUId = [];
    var eX = [];
    var eY = [];
    var eId = [];
    for (ui = 0; ui < units.length; ui += 1) {
        var u = units[ui];
        if (u === undefined) {
            continue;
        }
        if (u.owner === me) {
            myUId.push(u.id);
            myUX.push(u.x);
            myUY.push(u.y);
            myUT.push(u.type);
            myUCarry.push(u.carrying);
        }
        else {
            eX.push(u.x);
            eY.push(u.y);
            eId.push(u.id);
        }
    }
    var nW = 0;
    var nM = 0;
    var nR = 0;
    var ci = 0;
    for (ci = 0; ci < myUT.length; ci += 1) {
        var t = myUT[ci];
        if (t === undefined) {
            continue;
        }
        if (t === "worker") {
            nW += 1;
        }
        else {
            if (t === "melee") {
                nM += 1;
            }
            else {
                if (t === "ranged") {
                    nR += 1;
                }
            }
        }
    }
    var wantW = 6;
    if (tick >= 250) {
        wantW = 4;
    }
    if (tick < 250) {
        if (myMineX.length >= 3) {
            wantW = 8;
        }
        else {
            if (myMineX.length >= 2) {
                wantW = 7;
            }
        }
    }
    if (myMineX.length === 0) {
        if (nW < 4) {
            wantW = 4;
        }
        else {
            wantW = nW;
        }
    }
    if (wantW > 8) {
        wantW = 8;
    }
    var budget = myRes;
    var bi = 0;
    for (bi = 0; bi < myBasesId.length; bi += 1) {
        var isNull = myBasesProdNull[bi];
        if (isNull === undefined) {
            continue;
        }
        if (isNull !== 1) {
            continue;
        }
        var bId = myBasesId[bi];
        if (bId === undefined) {
            continue;
        }
        if (nW < wantW) {
            if (budget < 4) {
                continue;
            }
            var sresW = spawnUnit(bId, "worker");
            if (isError(sresW)) {
                var cdw = errCode(sresW);
                if (cdw === ERR_NOT_ENOUGH_RESOURCES) {
                    continue;
                }
                continue;
            }
            else {
                budget -= 4;
                nW += 1;
            }
        }
        else {
            var needRanged = 0;
            if (nR + nR <= nM) {
                needRanged = 1;
            }
            else {
                needRanged = 0;
            }
            if (tick < 60) {
                needRanged = 0;
            }
            if (needRanged === 1) {
                if (budget >= 12) {
                    var sresR = spawnUnit(bId, "ranged");
                    if (isError(sresR)) {
                        continue;
                    }
                    else {
                        budget -= 12;
                        nR += 1;
                    }
                }
                else {
                    if (budget >= 8) {
                        var sresM2 = spawnUnit(bId, "melee");
                        if (isError(sresM2)) {
                            continue;
                        }
                        else {
                            budget -= 8;
                            nM += 1;
                        }
                    }
                    else {
                        continue;
                    }
                }
            }
            else {
                if (budget >= 8) {
                    var sresM = spawnUnit(bId, "melee");
                    if (isError(sresM)) {
                        continue;
                    }
                    else {
                        budget -= 8;
                        nM += 1;
                    }
                }
                else {
                    continue;
                }
            }
        }
    }
    var k = 0;
    for (k = 0; k < myUId.length; k += 1) {
        var uid = myUId[k];
        var ux = myUX[k];
        var uy = myUY[k];
        var ut = myUT[k];
        var uc = myUCarry[k];
        if (uid === undefined) {
            continue;
        }
        if (ux === undefined) {
            continue;
        }
        if (uy === undefined) {
            continue;
        }
        if (ut === undefined) {
            continue;
        }
        if (uc === undefined) {
            uc = 0;
        }
        var onOwnBase = 0;
        var bq = 0;
        for (bq = 0; bq < myBasesX.length; bq += 1) {
            var bx0 = myBasesX[bq];
            var by0 = myBasesY[bq];
            if (bx0 === undefined) {
                continue;
            }
            if (by0 === undefined) {
                continue;
            }
            if (ux === bx0 && uy === by0) {
                onOwnBase = 1;
            }
        }
        if (onOwnBase === 1) {
            var dir = (uid + tick) % 8;
            var mdx = 1;
            var mdy = 0;
            if (dir === 0) {
                mdx = 1;
                mdy = 0;
            }
            else {
                if (dir === 1) {
                    mdx = 1;
                    mdy = 1;
                }
                else {
                    if (dir === 2) {
                        mdx = 0;
                        mdy = 1;
                    }
                    else {
                        if (dir === 3) {
                            mdx = -1;
                            mdy = 1;
                        }
                        else {
                            if (dir === 4) {
                                mdx = -1;
                                mdy = 0;
                            }
                            else {
                                if (dir === 5) {
                                    mdx = -1;
                                    mdy = -1;
                                }
                                else {
                                    if (dir === 6) {
                                        mdx = 0;
                                        mdy = -1;
                                    }
                                    else {
                                        mdx = 1;
                                        mdy = -1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            var mr = move(uid, mdx, mdy);
            if (isError(mr)) {
                var mc0 = errCode(mr);
                if (mc0 === ERR_INVALID_UNIT) {
                    continue;
                }
                if (mc0 === ERR_NOT_OWNER) {
                    continue;
                }
                var mr2 = moveTo(uid, ux + mdx + mdx, uy + mdy + mdy);
                if (isError(mr2)) {
                    errCode(mr2);
                }
            }
            continue;
        }
        if (ut === "worker") {
            var bestED = 99999;
            var bestEX = 0;
            var bestEY = 0;
            var eq = 0;
            for (eq = 0; eq < eX.length; eq += 1) {
                var ex0 = eX[eq];
                var ey0 = eY[eq];
                if (ex0 === undefined) {
                    continue;
                }
                if (ey0 === undefined) {
                    continue;
                }
                var dd0 = cheb(ux, uy, ex0, ey0);
                if (dd0 < bestED) {
                    bestED = dd0;
                    bestEX = ex0;
                    bestEY = ey0;
                }
            }
            if (eX.length > 0 && bestED <= 2) {
                var fdx = signInt(ux - bestEX);
                var fdy = signInt(uy - bestEY);
                if (fdx === 0 && fdy === 0) {
                    var fd = (uid + tick) % 8;
                    if (fd === 0) {
                        fdx = 1;
                        fdy = 0;
                    }
                    else {
                        if (fd === 1) {
                            fdx = 0;
                            fdy = 1;
                        }
                        else {
                            if (fd === 2) {
                                fdx = -1;
                                fdy = 0;
                            }
                            else {
                                if (fd === 3) {
                                    fdx = 0;
                                    fdy = -1;
                                }
                                else {
                                    if (fd === 4) {
                                        fdx = 1;
                                        fdy = 1;
                                    }
                                    else {
                                        if (fd === 5) {
                                            fdx = -1;
                                            fdy = 1;
                                        }
                                        else {
                                            if (fd === 6) {
                                                fdx = -1;
                                                fdy = -1;
                                            }
                                            else {
                                                fdx = 1;
                                                fdy = -1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (fdx === 0 && fdy === 0) {
                    fdx = 1;
                }
                var fr = move(uid, fdx, fdy);
                if (isError(fr)) {
                    var fc = errCode(fr);
                    if (fc === ERR_INVALID_UNIT) {
                        continue;
                    }
                    var fr2 = moveTo(uid, ux + fdx + fdx + fdx, uy + fdy + fdy + fdy);
                    if (isError(fr2)) {
                        errCode(fr2);
                    }
                }
                continue;
            }
            if (uc >= 20) {
                if (myBasesX.length === 0) {
                    if (capX.length > 0) {
                        var bd0 = 99999;
                        var btx0 = ux;
                        var bty0 = uy;
                        var bqi = 0;
                        for (bqi = 0; bqi < capX.length; bqi += 1) {
                            var cx0 = capX[bqi];
                            var cy0 = capY[bqi];
                            if (cx0 === undefined) {
                                continue;
                            }
                            if (cy0 === undefined) {
                                continue;
                            }
                            var ddc0 = cheb(ux, uy, cx0, cy0);
                            if (ddc0 < bd0) {
                                bd0 = ddc0;
                                btx0 = cx0;
                                bty0 = cy0;
                            }
                        }
                        var br0 = moveTo(uid, btx0, bty0);
                        if (isError(br0)) {
                            errCode(br0);
                        }
                    }
                    continue;
                }
                var nbd = 99999;
                var nbx = ux;
                var nby = uy;
                var nbq = 0;
                for (nbq = 0; nbq < myBasesX.length; nbq += 1) {
                    var nxx = myBasesX[nbq];
                    var nyy = myBasesY[nbq];
                    if (nxx === undefined) {
                        continue;
                    }
                    if (nyy === undefined) {
                        continue;
                    }
                    var ndd = cheb(ux, uy, nxx, nyy);
                    if (ndd < nbd) {
                        nbd = ndd;
                        nbx = nxx;
                        nby = nyy;
                    }
                }
                if (nbd <= 1) {
                    var tr = transfer(uid);
                    if (isError(tr)) {
                        var tc = errCode(tr);
                        if (tc === ERR_INVALID_UNIT) {
                            continue;
                        }
                        if (tc === ERR_NOT_OWNER) {
                            continue;
                        }
                        if (tc === ERR_INVALID_SITE) {
                            var trm = moveTo(uid, nbx, nby);
                            if (isError(trm)) {
                                errCode(trm);
                            }
                        }
                    }
                }
                else {
                    var tmr = moveTo(uid, nbx, nby);
                    if (isError(tmr)) {
                        errCode(tmr);
                    }
                }
                continue;
            }
            else {
                if (myMineX.length === 0) {
                    if (capX.length === 0) {
                        continue;
                    }
                    var cd0 = 99999;
                    var ctx0 = ux;
                    var cty0 = uy;
                    var cqi = 0;
                    for (cqi = 0; cqi < capX.length; cqi += 1) {
                        var qx0 = capX[cqi];
                        var qy0 = capY[cqi];
                        if (qx0 === undefined) {
                            continue;
                        }
                        if (qy0 === undefined) {
                            continue;
                        }
                        var qd0 = cheb(ux, uy, qx0, qy0);
                        if (qd0 < cd0) {
                            cd0 = qd0;
                            ctx0 = qx0;
                            cty0 = qy0;
                        }
                    }
                    var cmr = moveTo(uid, ctx0, cty0);
                    if (isError(cmr)) {
                        errCode(cmr);
                    }
                    continue;
                }
                var md = 99999;
                var mx = ux;
                var myy = uy;
                var mid = -1;
                var mq = 0;
                for (mq = 0; mq < myMineX.length; mq += 1) {
                    var vmx = myMineX[mq];
                    var vmy = myMineY[mq];
                    var vmid = myMineId[mq];
                    if (vmx === undefined) {
                        continue;
                    }
                    if (vmy === undefined) {
                        continue;
                    }
                    if (vmid === undefined) {
                        continue;
                    }
                    var vdd = cheb(ux, uy, vmx, vmy);
                    if (vdd < md) {
                        md = vdd;
                        mx = vmx;
                        myy = vmy;
                        mid = vmid;
                    }
                }
                if (mid < 0) {
                    continue;
                }
                if (md <= 1) {
                    var hr = harvest(uid, mid);
                    if (isError(hr)) {
                        var hc = errCode(hr);
                        if (hc === ERR_INVALID_UNIT) {
                            continue;
                        }
                        if (hc === ERR_INVALID_SITE) {
                            var hm = moveTo(uid, mx, myy);
                            if (isError(hm)) {
                                errCode(hm);
                            }
                        }
                        if (hc === ERR_OUT_OF_RANGE) {
                            var hm2 = moveTo(uid, mx, myy);
                            if (isError(hm2)) {
                                errCode(hm2);
                            }
                        }
                    }
                }
                else {
                    var hmr = moveTo(uid, mx, myy);
                    if (isError(hmr)) {
                        errCode(hmr);
                    }
                }
                continue;
            }
        }
        else {
            var myRange = 1;
            if (ut === "ranged") {
                myRange = 2;
            }
            var ned = 99999;
            var nex = ux;
            var ney = uy;
            var neid = -1;
            var nq = 0;
            for (nq = 0; nq < eX.length; nq += 1) {
                var avx = eX[nq];
                var avy = eY[nq];
                var aid = eId[nq];
                if (avx === undefined) {
                    continue;
                }
                if (avy === undefined) {
                    continue;
                }
                if (aid === undefined) {
                    continue;
                }
                var add = cheb(ux, uy, avx, avy);
                if (add < ned) {
                    ned = add;
                    nex = avx;
                    ney = avy;
                    neid = aid;
                }
                if (ned <= myRange) {
                    break;
                }
            }
            if (neid >= 0 && ned <= myRange) {
                var ar = attack(uid, neid);
                if (isError(ar)) {
                    var ac = errCode(ar);
                    if (ac === ERR_INVALID_UNIT) {
                        continue;
                    }
                    if (ac === ERR_INVALID_TARGET) {
                        continue;
                    }
                    if (ac === ERR_OUT_OF_RANGE) {
                        var am = moveTo(uid, nex, ney);
                        if (isError(am)) {
                            errCode(am);
                        }
                    }
                }
                continue;
            }
            var holding = 0;
            var hq = 0;
            for (hq = 0; hq < capX.length; hq += 1) {
                var hxx = capX[hq];
                var hyy = capY[hq];
                if (hxx === undefined) {
                    continue;
                }
                if (hyy === undefined) {
                    continue;
                }
                if (ux === hxx && uy === hyy) {
                    holding = 1;
                }
            }
            if (holding === 1) {
                continue;
            }
            if (neid >= 0 && ned <= 5) {
                var cr = moveTo(uid, nex, ney);
                if (isError(cr)) {
                    errCode(cr);
                }
                continue;
            }
            if (capX.length === 0) {
                if (neid >= 0) {
                    var hr2 = moveTo(uid, nex, ney);
                    if (isError(hr2)) {
                        errCode(hr2);
                    }
                }
                else {
                    if (myMineX.length > 0) {
                        var gd = 99999;
                        var gx = ux;
                        var gy = uy;
                        var gq = 0;
                        for (gq = 0; gq < myMineX.length; gq += 1) {
                            var gxx = myMineX[gq];
                            var gyy = myMineY[gq];
                            if (gxx === undefined) {
                                continue;
                            }
                            if (gyy === undefined) {
                                continue;
                            }
                            var gdd = cheb(ux, uy, gxx, gyy);
                            if (gdd < gd && gdd > 1) {
                                gd = gdd;
                                gx = gxx;
                                gy = gyy;
                            }
                        }
                        if (gd !== 99999) {
                            var gr = moveTo(uid, gx, gy);
                            if (isError(gr)) {
                                errCode(gr);
                            }
                        }
                    }
                }
                continue;
            }
            var td = 99999;
            var tx = ux;
            var ty = uy;
            var tq = 0;
            for (tq = 0; tq < capX.length; tq += 1) {
                var tcx = capX[tq];
                var tcy = capY[tq];
                var isB = capKindIsBase[tq];
                if (tcx === undefined) {
                    continue;
                }
                if (tcy === undefined) {
                    continue;
                }
                if (isB === undefined) {
                    isB = 0;
                }
                var tdd = cheb(ux, uy, tcx, tcy);
                if (tick < 200 && isB === 1) {
                    tdd += 6;
                }
                if (tdd < td) {
                    td = tdd;
                    tx = tcx;
                    ty = tcy;
                }
            }
            var tmr2 = moveTo(uid, tx, ty);
            if (isError(tmr2)) {
                errCode(tmr2);
            }
            continue;
        }
    }
}
