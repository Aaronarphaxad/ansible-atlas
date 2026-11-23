Database notes
==============

MongoDB runs on `app-stg-mongo01`; the config template is
[mongod.conf.j2](../roles/mongodb/templates/mongod.conf.j2).

Restore from a backup:

    mongorestore --archive=backup.archive.gz --gzip

Back to the [runbook](runbook.md#deploy).
