MRuby::CrossBuild.new('niao-ruby') do |conf|
  conf.toolchain :clang
  conf.cc.command = 'emcc'
  conf.linker.command = 'emcc'
  conf.archiver.command = 'emar'
  conf.cc.flags << '-sSUPPORT_LONGJMP=wasm'
  conf.cc.flags << '-sWASM_LEGACY_EXCEPTIONS=0'
  conf.linker.flags << '-sSUPPORT_LONGJMP=wasm'
  conf.linker.flags << '-sWASM_LEGACY_EXCEPTIONS=0'
  conf.cc.defines += %w[PICORB_PLATFORM_WASM MRB_32BIT MRB_INT64 MRB_NO_BOXING MRB_UTF8_STRING MRB_USE_DEBUG_HOOK PRISM_DEPTH_MAXIMUM=64]
  conf.ports :niao
  conf.picoruby(alloc_estalloc: false)
  conf.gem core: 'mruby-compiler'
  core = File.join(MRUBY_ROOT, 'mrbgems/picoruby-mruby/lib/mruby/mrbgems')
  %w[mruby-array-ext mruby-enum-ext mruby-hash-ext mruby-string-ext mruby-numeric-ext mruby-math].each { |g| conf.gem gemdir: File.join(core, g) }
  conf.gem gemdir: ENV.fetch('NIAO_SANDBOX_ROOT')
end
