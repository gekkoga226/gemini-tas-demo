実験用joint.response.v1。入力動画一つについて区間と作業名を同時に判定する。
区間は入力動画先頭0秒の秒数値。語彙と識別条件を参考に観察し、工程順で補完しない。
反復、短い動作、抜け、逆順を保全する。confidenceは正解保証に使わない。
各区間はsegment_id,start_s,end_s,job_no,job_title,evidence（description,start_s,end_s）を返す。
説明できない時間はunresolvedにstart_s,end_s,reasonとして明示する。JSON以外を返さない。
