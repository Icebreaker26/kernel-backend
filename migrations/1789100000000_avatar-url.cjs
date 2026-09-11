exports.up = (pgm) => {
  pgm.addColumn('global_usuarios', {
    avatar_url: { type: 'varchar(500)' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('global_usuarios', 'avatar_url');
};
